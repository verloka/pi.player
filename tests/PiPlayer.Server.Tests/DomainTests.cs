using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PiPlayer.Server.Configuration;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Services;
using Xunit;
namespace PiPlayer.Server.Tests;

public class DomainTests
{
    private static CommandEnvelope Command(string target, string type, object payload) => new(Json.Id(), target, type, JsonSerializer.SerializeToElement(payload, Json.Options));
    [Theory]
    [InlineData("https://youtube.com/watch?v=dQw4w9WgXcQ")]
    [InlineData("https://youtu.be/dQw4w9WgXcQ")]
    [InlineData("https://www.youtube.com/embed/dQw4w9WgXcQ")]
    [InlineData("https://m.youtube.com/shorts/dQw4w9WgXcQ")]
    public void YouTubeNormalizesKnownFormats(string url) => Assert.Equal(new YouTubeVideo("dQw4w9WgXcQ"), Validate.YouTube(url));
    [Theory]
    [InlineData("https://youtube.com.example.org/watch?v=dQw4w9WgXcQ")]
    [InlineData("https://music.youtube.com/watch?v=dQw4w9WgXcQ")]
    [InlineData("javascript:alert(1)")]
    [InlineData("https://youtube.com/watch?v=wrong")]
    [InlineData("https://user:password@youtube.com/watch?v=dQw4w9WgXcQ")]
    public void YouTubeRejectsDeceptiveUrls(string url) => Assert.Throws<ApiException>(() => Validate.YouTube(url));
    [Fact] public void PlaylistTakesPrecedenceAndVideoOnlyIsExplicit()
    { const string url = "https://youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ"; Assert.IsType<YouTubePlaylist>(Validate.YouTube(url)); Assert.IsType<YouTubeVideo>(Validate.YouTube(url, true)); }
    [Theory]
    [InlineData("file:///etc/passwd")][InlineData("data:audio/mp3;base64,abcd")][InlineData("https://music.youtube.com/watch?v=dQw4w9WgXcQ")][InlineData("https://example.org/radio.m3u8")][InlineData("https://user:secret@example.org/audio.mp3")]
    public void InvalidRemoteRejected(string url) => Assert.Throws<ApiException>(() => Validate.Remote(url, new()));
    [Fact] public void RemoteWithoutExtensionAcceptedAndFingerprintRedactsToken()
    { var source = new RemoteAudioUrl("https://radio.example/stream?token=secret"); Assert.Equal(source.Url, Validate.Remote(source.Url, new())); Assert.DoesNotContain("secret", Validate.Fingerprint(source)); Assert.Equal(79, Validate.Fingerprint(source).Length); }
    [Fact] public void Geometry100_20_33RotatesAroundTheCentre()
    {
        var t = new Transform(100, 20, 800, 450, 1, 33); var p = Geometry.Corners(t);
        Assert.Equal(new Point(500, 245), Geometry.Centre(t));
        Assert.Equal(287.075556, p[0].X, 5); Assert.Equal(-161.556492, p[0].Y, 5);
        Assert.Equal(958.012010, p[1].X, 5); Assert.Equal(274.154736, p[1].Y, 5);
        Assert.Equal(41.987990, p[3].X, 5); Assert.Equal(215.845264, p[3].Y, 5);
        // Opposite corners stay symmetric about the centre.
        Assert.Equal(500, (p[0].X + p[2].X) / 2, 5); Assert.Equal(245, (p[0].Y + p[2].Y) / 2, 5);
        Assert.Equal(t, Geometry.Check(t, false, new()));
    }
    [Fact] public void YouTubeStillRequiresAnOpaqueUncroppedFrameOfAtLeast200Square()
    {
        Assert.Throws<ApiException>(() => Geometry.Check(new(0, 0, 640, 360, 1, 0, .5), true, new()));
        Assert.Throws<ApiException>(() => Geometry.Check(new(0, 0, 640, 360, 1, 0, 1, "cover"), true, new()));
        Assert.Throws<ApiException>(() => Geometry.Check(new(0, 0, 150, 150), true, new()));
        // Scaling the frame up is fine: the constraint is on the frame, not on the screen it overflows.
        Assert.Equal(2, Geometry.Check(new(0, 0, 640, 360, 2), true, new()).Scale);
    }
    [Fact] public void YouTubeMayHangOffScreenAndRotationFollowsItsSwitch()
    {
        var rotated = new Transform(-400, -300, 400, 300, 1, 33);
        Assert.Equal("capabilityNotSupported", Assert.Throws<ApiException>(() => Geometry.Check(rotated, true, new() { EnableExperimentalYouTubeRotation = false })).Code);
        // Rotated and far outside the screen: accepted, because only the frame itself is constrained.
        Assert.Equal(rotated, Geometry.Check(rotated, true, new()));
        var offscreen = rotated with { Rotation = 0 };
        Assert.Equal(offscreen, Geometry.Check(offscreen, true, new() { EnableExperimentalYouTubeRotation = false }));
        // Local video rotation never depended on the switch.
        Assert.Equal(rotated, Geometry.Check(rotated, false, new() { EnableExperimentalYouTubeRotation = false }));
    }
    [Fact] public void GeometryRejectsResourceExhaustionAndNonFinite()
    { Assert.Throws<ApiException>(() => Geometry.Check(new(Width: 4096, Height: 4096, Scale: 8), false, new())); Assert.Throws<ApiException>(() => Geometry.Check(new(X: double.NaN), false, new())); }
    [Fact] public void ChannelsAndVolumeMuteRemainIndependent()
    {
        var state = new DesiredState { Visual = new() { Source = new YouTubeVideo("dQw4w9WgXcQ"), Transport = "playing" } };
        var next = Reducer.Apply(state, Command("audio", "setSource", new { source = (AudioSource)new LocalFile(Json.Id()), autoplay = true }), null);
        Assert.Equal(state.Visual, next.Visual); Assert.Equal("playing", next.Audio.Transport);
        var muted = Reducer.Apply(next, Command("audio", "setMuted", new { value = true }), null);
        Assert.Equal(next.Audio.Playback.Volume, muted.Audio.Playback.Volume); Assert.Equal(next.Audio.PlaybackGeneration, muted.Audio.PlaybackGeneration);
        var stopped = Reducer.Apply(muted, Command("system", "stopAll", new { }), null);
        Assert.Equal(state.Visual.Source, stopped.Visual.Source); Assert.Equal(next.Audio.Source, stopped.Audio.Source); Assert.Equal("stopped", stopped.Visual.Transport); Assert.Equal("stopped", stopped.Audio.Transport);
    }
    [Fact] public void PauseAndTransformDontChangeGenerationButSeekAndRestartDo()
    {
        var state = new DesiredState { Visual = new() { Source = new LocalVideo(Json.Id()), Transport = "playing", PlaybackGeneration = 7 } };
        var paused = Reducer.Apply(state, Command("visual", "pause", new { }), null); Assert.Equal(7, paused.Visual.PlaybackGeneration);
        var transformed = Reducer.Apply(paused, Command("visual", "setTransform", new Transform(100,20,800,450,1,33)), null); Assert.Equal(7, transformed.Visual.PlaybackGeneration);
        var seek = Reducer.Apply(transformed, Command("visual", "seek", new { seconds = 12 }), new() { DurationSeconds = 30, Capabilities = new(CanSeek: true) }); Assert.Equal(8, seek.Visual.PlaybackGeneration); Assert.Equal(12, seek.Visual.StartPositionSeconds); Assert.Equal("paused", seek.Visual.Transport);
        var replay = Reducer.Apply(seek, Command("visual", "play", new { }), new() { Status = "ended" }); Assert.Equal(9, replay.Visual.PlaybackGeneration); Assert.Equal(0, replay.Visual.StartPositionSeconds);
    }
    [Fact] public void SourceDiscriminatorsMatchContractAndRejectUnexpectedFields()
    {
        var state = new DesiredState { Visual = new() { Source = new YouTubePlaylist("RDdQw4w9WgXcQ", "dQw4w9WgXcQ") }, Audio = new() { Source = new LocalFile(Json.Id()) } };
        var json = JsonSerializer.Serialize(state, Json.Options); Assert.Contains("\"kind\": \"youtubePlaylist\"", json); Assert.Contains("\"kind\": \"localFile\"", json);
        Assert.Equal(state, JsonSerializer.Deserialize<DesiredState>(json, Json.Options));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Transform>("{\"unknown\":1}", Json.Options));
    }
    [Fact] public void CircleStartsInTheMiddleAndMovesWithoutTouchingTheVideo()
    {
        // A runtime document saved before the circle existed still loads, with the circle at the screen centre.
        var legacy = JsonSerializer.Deserialize<DesiredState>("{\"visual\":{},\"audio\":{},\"background\":{\"color\":\"#000000\"}}", Json.Options)!;
        Assert.Equal(new Circle(), legacy.Circle); Assert.Equal(0, legacy.Circle.X); Assert.Equal(0, legacy.Circle.Y);
        var state = new DesiredState { Visual = new() { Source = new LocalVideo(Json.Id()), Transport = "playing", PlaybackGeneration = 3 } };
        var moved = Reducer.Apply(state, Command("system", "setCircle", new Circle(-120, 40, 300, "#3366ff", false)), null);
        Assert.Equal(new Circle(-120, 40, 300, "#3366ff", false), moved.Circle); Assert.Equal(state.Visual, moved.Visual);
        Assert.Equal(moved.Circle, Geometry.CheckCircle(moved.Circle));
        Assert.Throws<ApiException>(() => Geometry.CheckCircle(new(Diameter: -1)));
        Assert.Throws<ApiException>(() => Geometry.CheckCircle(new(X: double.NaN)));
        Assert.Throws<ApiException>(() => Geometry.CheckCircle(new(Color: "red")));
    }
    [Fact] public void LeaseRejectsSecondScreenAndOldConnection()
    {
        var sessions = new ScreenSessions(); var first = new ScreenDescriptor("primary", Json.Id(), new(1280,720)); var second = first with { PageSessionId = Json.Id() };
        Assert.True(sessions.Register("a", first)); Assert.False(sessions.Register("b", second)); Assert.True(sessions.Register("c", first)); Assert.False(sessions.Heartbeat("a", first.PageSessionId)); Assert.True(sessions.Heartbeat("c", first.PageSessionId)); sessions.Disconnect("a"); Assert.True(sessions.Status.Connected); sessions.Disconnect("c"); Assert.True(sessions.Register("b", second));
    }
    [Fact] public async Task AtomicUpdatesPreserveConcurrentChangesAndRecoverBackup()
    {
        using var temp = new TempData(); var store = temp.Store;
        await Task.WhenAll(Enumerable.Range(0,20).Select(_ => store.Update<CollectionDocument<string>>("library/test.json", d => { d.Items.Add(Json.Id()); return d; })));
        var doc = await store.Read<CollectionDocument<string>>("library/test.json"); Assert.Equal(20, doc.Items.Count); Assert.Equal(20, doc.DocumentRevision);
        await Assert.ThrowsAsync<ApiException>(() => store.Update<CollectionDocument<string>>("library/test.json", d => d, 0));
        await File.WriteAllTextAsync(temp.Paths.Get("library/test.json"), "broken");
        var recovered = await store.Read<CollectionDocument<string>>("library/test.json"); Assert.Equal(19, recovered.Items.Count); Assert.NotEmpty(store.Warnings); Assert.Single(Directory.GetFiles(temp.Paths.Get("library"), "*.corrupt-*"));
    }
    [Fact] public async Task FutureSchemaIsNeverOverwrittenEvenWithBackup()
    { using var temp = new TempData(); var file = temp.Paths.Get("settings/future.json"); await File.WriteAllTextAsync(file, "{\"schemaVersion\":3}"); await Assert.ThrowsAsync<ApiException>(() => temp.Store.Update<StartupSettings>("settings/future.json", _ => new())); Assert.Equal("{\"schemaVersion\":3}", await File.ReadAllTextAsync(file)); }
    [Fact] public void TraversalRejectedAndAppRelativeRootStable()
    { using var temp = new TempData(); Assert.Throws<IOException>(() => temp.Paths.Get("../security.json")); Assert.EndsWith("data", new DataPaths(new() { DataPath = Path.Combine(temp.Root,"nested","data") }).Root); }
    [Theory][InlineData(".mp4", "not a video")][InlineData(".mp3", "<html>")][InlineData(".wav", "RIFFonly")]
    public void SignatureRejectsSpoofedExtensions(string ext,string body) => Assert.False(MediaLibrary.Signature(ext, System.Text.Encoding.UTF8.GetBytes(body)));
}
public sealed class TempData : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "piplayer-tests-" + Json.Id());
    public DataPaths Paths { get; }
    public JsonStore Store { get; }
    public TempData() { Paths = new(new() { DataPath = Root }); Store = new(Paths, NullLogger<JsonStore>.Instance); }
    public void Dispose() { if (Directory.Exists(Root) && Path.GetFileName(Root).StartsWith("piplayer-tests-", StringComparison.Ordinal)) Directory.Delete(Root, true); }
}

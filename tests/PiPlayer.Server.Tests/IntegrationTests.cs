using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Services;
using Xunit;
namespace PiPlayer.Server.Tests;

public sealed class TestApp : WebApplicationFactory<Program>
{
    public TempData Data { get; } = new();
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("PiPlayer:DataPath", Data.Root);
        builder.UseSetting("PiPlayer:MinFreeDiskBytes", "0");
        builder.UseSetting("PiPlayer:MaxVideoUploadBytes", "1024");
        builder.UseSetting("PiPlayer:MaxAudioUploadBytes", "1024");
        builder.UseSetting("AllowedHosts", "localhost");
    }
    // The appliance has no accounts. The header is an editor identity for drag arbitration, never a credential.
    public Task<HttpClient> Admin()
    {
        var client = CreateClient(new() { BaseAddress = new("http://localhost:5000"), AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add("Origin", "http://localhost:5000");
        client.DefaultRequestHeaders.Add(Client.HeaderName, Json.Id());
        return Task.FromResult(client);
    }
    protected override void Dispose(bool disposing) { base.Dispose(disposing); if (disposing) Data.Dispose(); }
}
public class IntegrationTests
{
    [Fact] public async Task EveryRouteIsOpenWithoutLoginAndUnknownRoutesStay404()
    {
        using var app = new TestApp(); using var anonymous = app.CreateClient(new() { BaseAddress = new("http://localhost:5000") });
        // No cookie, no token, no header: a plain client still reads and writes.
        Assert.NotNull(await anonymous.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options));
        Assert.True((await anonymous.GetFromJsonAsync<JsonElement>("/api/system/ready")).GetProperty("ready").GetBoolean());
        (await anonymous.GetAsync("/api/library/videos")).EnsureSuccessStatusCode();
        (await anonymous.GetAsync("/api/system/diagnostics")).EnsureSuccessStatusCode();
        (await anonymous.GetAsync("/api/system/kiosk-status")).EnsureSuccessStatusCode();
        // The retired login surface must not answer at all.
        foreach (var path in new[] { "/api/auth/session", "/api/auth/csrf", "/api/does-not-exist", "/media/does-not-exist" })
            Assert.Equal(HttpStatusCode.NotFound, (await anonymous.GetAsync(path)).StatusCode);
        foreach (var path in new[] { "/api/auth/login", "/api/auth/logout", "/api/screen/session" })
            Assert.Equal(HttpStatusCode.NotFound, (await anonymous.PostAsJsonAsync(path, new { })).StatusCode);
        // A foreign Origin is no longer rejected, and no CSRF token is demanded for writes.
        anonymous.DefaultRequestHeaders.Add("Origin", "https://other.example");
        var state = (await anonymous.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!;
        (await anonymous.PostAsJsonAsync("/api/commands", Cmd(state, "visual", "setTransform", new Transform(10, 10, 320, 180, 1, 0)), Json.Options)).EnsureSuccessStatusCode();
    }
    [Fact] public async Task CircleCommandChangesTheSceneAndTravelsWithVisualPresets()
    {
        using var app = new TestApp(); using var client = await app.Admin();
        async Task<StateEnvelope> State() => (await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!;
        var state = await State(); Assert.Equal(new Circle(), state.Desired.Circle);
        var circle = new Circle(80, -30, 250, "#ff8800", true);
        (await client.PostAsJsonAsync("/api/commands", Cmd(state, "system", "setCircle", circle), Json.Options)).EnsureSuccessStatusCode();
        state = await State(); Assert.Equal(circle, state.Desired.Circle);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await client.PostAsJsonAsync("/api/commands", Cmd(state, "system", "setCircle", circle with { Diameter = -5 }), Json.Options)).StatusCode);
        var saved = await client.PostAsJsonAsync("/api/presets/visual", new { name = "Circle", source = (object?)null, visible = true, transform = new Transform(), playback = new VisualPlayback(), initialPositionSeconds = 0, circle }, Json.Options);
        saved.EnsureSuccessStatusCode();
        var presetId = (await saved.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("items")[0].GetProperty("id").GetString();
        state = await State();
        (await client.PostAsJsonAsync("/api/commands", Cmd(state, "system", "setCircle", new Circle()), Json.Options)).EnsureSuccessStatusCode();
        state = await State(); Assert.Equal(new Circle(), state.Desired.Circle);
        (await client.PostAsJsonAsync("/api/commands", Cmd(state, "system", "applyPresets", new { visualPresetId = presetId, autoplay = false }), Json.Options)).EnsureSuccessStatusCode();
        Assert.Equal(circle, (await State()).Desired.Circle);
    }
    [Fact] public async Task UploadRangeRenameReferencesAndDelete()
    {
        using var app = new TestApp(); using var client = await app.Admin(); var asset = await Upload(client); var id = asset.GetProperty("asset").GetProperty("id").GetString()!;
        using var range = new HttpRequestMessage(HttpMethod.Get, "/media/videos/" + id); range.Headers.Range = new RangeHeaderValue(0, 7);
        var rangeResponse = await client.SendAsync(range); Assert.Equal(HttpStatusCode.PartialContent, rangeResponse.StatusCode); Assert.Equal(8, (await rangeResponse.Content.ReadAsByteArrayAsync()).Length);
        using var head = new HttpRequestMessage(HttpMethod.Head, "/media/videos/" + id); var headResponse = await client.SendAsync(head); Assert.Equal(32, headResponse.Content.Headers.ContentLength);
        using var invalid = new HttpRequestMessage(HttpMethod.Get, "/media/videos/" + id); invalid.Headers.Range = new RangeHeaderValue(999, 1000); Assert.Equal(HttpStatusCode.RequestedRangeNotSatisfiable, (await client.SendAsync(invalid)).StatusCode);
        var state = await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options);
        var command = Cmd(state!, "visual", "setSource", new { source = (VisualSource)new LocalVideo(id), autoplay = true });
        var selected = await client.PostAsJsonAsync("/api/commands", command, Json.Options); selected.EnsureSuccessStatusCode();
        using var deletion = new HttpRequestMessage(HttpMethod.Delete, "/api/library/videos/" + id); deletion.Headers.IfMatch.Add(new EntityTagHeaderValue("\"1\""));
        var inUse = await client.SendAsync(deletion); Assert.Equal(HttpStatusCode.Conflict, inUse.StatusCode); Assert.Contains("runtime.visual", await inUse.Content.ReadAsStringAsync());
        state = await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options); (await client.PostAsJsonAsync("/api/commands", Cmd(state!, "visual", "clear", new { }), Json.Options)).EnsureSuccessStatusCode();
        using var rename = new HttpRequestMessage(HttpMethod.Patch, "/api/library/videos/" + id) { Content = JsonContent.Create(new { displayName = "Renamed" }) }; rename.Headers.IfMatch.Add(new EntityTagHeaderValue("\"1\"")); (await client.SendAsync(rename)).EnsureSuccessStatusCode();
        var renamed = await client.GetFromJsonAsync<Asset>("/api/library/videos/" + id, Json.Options); Assert.Equal(id + ".mp4", renamed!.FileName);
        using var delete = new HttpRequestMessage(HttpMethod.Delete, "/api/library/videos/" + id); delete.Headers.IfMatch.Add(new EntityTagHeaderValue("\"2\"")); (await client.SendAsync(delete)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/media/videos/" + id)).StatusCode);
    }
    [Fact] public async Task UploadEnforcesSignatureSizeAndCleansPartial()
    {
        using var app = new TestApp(); using var client = await app.Admin();
        using var spoof = new MultipartFormDataContent(); spoof.Add(new ByteArrayContent("<html>fake"u8.ToArray()), "file", "fake.mp4"); Assert.Equal(HttpStatusCode.UnsupportedMediaType, (await client.PostAsync("/api/library/videos", spoof)).StatusCode);
        using var large = new MultipartFormDataContent(); large.Add(new ByteArrayContent(new byte[1500]), "file", "large.mp4"); Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await client.PostAsync("/api/library/videos", large)).StatusCode);
        Assert.Empty(Directory.GetFiles(app.Data.Paths.Get("uploads"))); Assert.Empty(Directory.GetFiles(app.Data.Paths.Get("media/videos")));
    }
    [Fact] public async Task DispatcherDeduplicatesBeforeRevisionChecksAndProtectsDrag()
    {
        using var app = new TestApp(); using var client = await app.Admin(); var state = (await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!;
        var command = Cmd(state, "visual", "setTransform", new Transform(100,20,800,450,1,33));
        var first = await client.PostAsJsonAsync("/api/commands", command, Json.Options); first.EnsureSuccessStatusCode(); var receipt = await first.Content.ReadFromJsonAsync<CommandReceipt>(Json.Options);
        var retry = await client.PostAsJsonAsync("/api/commands", command, Json.Options); retry.EnsureSuccessStatusCode(); Assert.Equal(receipt, await retry.Content.ReadFromJsonAsync<CommandReceipt>(Json.Options));
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/commands", command with { Payload = JsonSerializer.SerializeToElement(new Transform(), Json.Options) }, Json.Options)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/commands", command with { CommandId = Json.Id() }, Json.Options)).StatusCode);
        state = (await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!; var drag = Cmd(state, "visual", "setTransform", new Transform(101,20,800,450,1,33)) with { InteractionId = Json.Id(), ClientSequence = 1, Commit = false };
        (await client.PostAsJsonAsync("/api/commands", drag, Json.Options)).EnsureSuccessStatusCode();
        (await client.PostAsJsonAsync("/api/commands", drag with { CommandId = Json.Id(), ClientSequence = 2, Commit = true }, Json.Options)).EnsureSuccessStatusCode();
        var final = (await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!; Assert.Equal("saved", final.Persistence); Assert.Equal(101, final.Desired.Visual.Transform.X);
        (await client.PostAsJsonAsync("/api/commands", Cmd(state, "system", "stopAll", new { }) with { ExpectedRevision = -100 }, Json.Options)).EnsureSuccessStatusCode();
    }
    [Fact] public async Task KioskWatchdogReportsScreenPresenceAndPlaybackWithoutASession()
    {
        using var app = new TestApp(); using var client = app.CreateClient(new() { BaseAddress = new("http://localhost:5000") });
        var status = await client.GetFromJsonAsync<JsonElement>("/api/system/kiosk-status");
        Assert.True(status.GetProperty("serverReady").GetBoolean());
        Assert.False(status.GetProperty("screenConnected").GetBoolean());
        // An SSH-only operator reads playback health from here; nothing is playing on a fresh device.
        Assert.False(status.GetProperty("playbackStalled").GetBoolean());
        Assert.False(status.GetProperty("soundWaitingForGesture").GetBoolean());
        var channels = status.GetProperty("channels").EnumerateArray().ToArray();
        Assert.Equal(["visual", "audio"], channels.Select(c => c.GetProperty("target").GetString()));
        Assert.All(channels, c => Assert.Equal("none", c.GetProperty("intent").GetString()));
        Assert.All(channels, c => Assert.Equal("unreported", c.GetProperty("status").GetString()));
        var diagnostics = await client.GetFromJsonAsync<JsonElement>("/api/system/diagnostics");
        Assert.False(diagnostics.GetProperty("playbackStalled").GetBoolean());
        Assert.Equal(2, diagnostics.GetProperty("channels").GetArrayLength());
    }
    [Fact] public async Task SilenceProbeIsARealWavTheScreenCanPlayUnmuted()
    {
        using var app = new TestApp(); using var client = app.CreateClient(new() { BaseAddress = new("http://localhost:5000") });
        var response = await client.GetAsync("/media/silence.wav");
        response.EnsureSuccessStatusCode();
        Assert.Equal("audio/wav", response.Content.Headers.ContentType?.MediaType);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(44 + 16000, bytes.Length);
        Assert.Equal("RIFF"u8.ToArray(), bytes[..4]);
        Assert.Equal("WAVE"u8.ToArray(), bytes[8..12]);
        Assert.All(bytes[44..], b => Assert.Equal(0, b));
    }
    [Fact] public async Task PresetSettingsSaveDoesNotChangeRuntimeAndStartupReferenceBlocksDeletion()
    {
        using var app = new TestApp(); using var client = await app.Admin(); var state = (await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!;
        var created = await client.PostAsJsonAsync("/api/presets/audio", new { name = "Radio", source = (AudioSource)new RemoteAudioUrl("https://radio.example/stream", "live"), playback = new Playback(), initialPositionSeconds = 0 }, Json.Options); created.EnsureSuccessStatusCode();
        var presets = (await created.Content.ReadFromJsonAsync<CollectionDocument<AudioPreset>>(Json.Options))!; var preset = Assert.Single(presets.Items);
        using var settings = new HttpRequestMessage(HttpMethod.Put, "/api/settings/startup") { Content = JsonContent.Create(new StartupSettings { DefaultAudioPresetId = preset.Id, StartAudioOnBoot = true }, options: Json.Options) }; settings.Headers.IfMatch.Add(new EntityTagHeaderValue("\"0\"")); (await client.SendAsync(settings)).EnsureSuccessStatusCode();
        Assert.Equal(state.Revision, (await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!.Revision);
        using var delete = new HttpRequestMessage(HttpMethod.Delete, "/api/presets/audio/" + preset.Id); delete.Headers.IfMatch.Add(new EntityTagHeaderValue("\"1\"")); Assert.Equal(HttpStatusCode.Conflict, (await client.SendAsync(delete)).StatusCode);
        (await client.PostAsJsonAsync("/api/commands", Cmd(state,"system","applyPresets",new { audioPresetId = preset.Id, autoplay = true }), Json.Options)).EnsureSuccessStatusCode();
        var applied = (await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!; Assert.Equal(state.Desired.Visual, applied.Desired.Visual); Assert.Equal("playing", applied.Desired.Audio.Transport); Assert.Empty(applied.Observed);
    }
    private static CommandEnvelope Cmd(StateEnvelope state, string target, string type, object payload) => new(Json.Id(), target, type, JsonSerializer.SerializeToElement(payload, Json.Options), state.Revision, target == "system" ? null : target == "visual" ? state.Desired.Visual.PlaybackGeneration : state.Desired.Audio.PlaybackGeneration);
    private static async Task<JsonElement> Upload(HttpClient client)
    {
        var bytes = new byte[32]; "ftyp"u8.CopyTo(bytes.AsSpan(4)); using var form = new MultipartFormDataContent(); form.Add(new ByteArrayContent(bytes), "file", "test.mp4"); var response = await client.PostAsync("/api/library/videos", form); response.EnsureSuccessStatusCode(); return await response.Content.ReadFromJsonAsync<JsonElement>();
    }
}

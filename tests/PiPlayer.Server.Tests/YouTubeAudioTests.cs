using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Services;
using Xunit;

namespace PiPlayer.Server.Tests;

public class YouTubeAudioTests
{
    private const string VideoId = "dQw4w9WgXcQ";

    private static async Task<StateEnvelope> State(HttpClient client) =>
        (await client.GetFromJsonAsync<StateEnvelope>("/api/system/state", Json.Options))!;

    private static async Task Send(HttpClient client, string target, string type, object payload)
    {
        var state = await State(client);
        var generation = target == "system" ? (long?)null : target == "audio"
            ? state.Desired.Audio.PlaybackGeneration : state.Desired.Visual.PlaybackGeneration;
        var command = new CommandEnvelope(Json.Id(), target, type,
            JsonSerializer.SerializeToElement(payload, Json.Options), state.Revision, generation);
        (await client.PostAsJsonAsync("/api/commands", command, Json.Options)).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task AudioCommandsAndPresetRoundTripPreserveTheVisualChannel()
    {
        using var app = new TestApp();
        using var client = await app.Admin();
        await Send(client, "visual", "setSource", new { source = (VisualSource)new YouTubeVideo(VideoId), autoplay = true });
        var visual = (await State(client)).Desired.Visual;
        AudioSource audio = new YouTubeAudio(VideoId);
        await Send(client, "audio", "setSource", new { source = audio, autoplay = true });
        await Send(client, "audio", "setVolume", new { value = 27 });
        await Send(client, "audio", "setMuted", new { value = true });
        await Send(client, "audio", "setLoop", new { value = true });
        await Send(client, "audio", "pause", new { });
        var selected = (await State(client)).Desired;
        Assert.Equal(visual, selected.Visual);
        Assert.Equal(audio, selected.Audio.Source);
        Assert.Equal(new Playback(true, true, 27), selected.Audio.Playback);
        Assert.Equal("paused", selected.Audio.Transport);
        Assert.Equal(selected, (await app.Data.Store.Read<RuntimeDocument>("settings/runtime-state.json")).Desired);
        Assert.Equal("youtubeAudio:" + VideoId, Validate.Fingerprint(audio));
        Assert.NotEqual(Validate.Fingerprint(visual.Source), Validate.Fingerprint(audio));

        var saved = await client.PostAsJsonAsync("/api/presets/audio", new
        {
            name = "YouTube audio", source = audio, playback = selected.Audio.Playback, initialPositionSeconds = 12
        }, Json.Options);
        saved.EnsureSuccessStatusCode();
        var preset = (await saved.Content.ReadFromJsonAsync<CollectionDocument<AudioPreset>>(Json.Options))!.Items.Single();
        Assert.Equal(audio, preset.Source);
        await Send(client, "audio", "setSource", new { source = (object?)null, autoplay = false });
        await Send(client, "system", "applyPresets", new { audioPresetId = preset.Id, autoplay = true });
        var restored = (await State(client)).Desired;
        Assert.Equal(audio, restored.Audio.Source);
        Assert.Equal(selected.Audio.Playback, restored.Audio.Playback);
        Assert.Equal(12, restored.Audio.StartPositionSeconds);
        Assert.Equal("playing", restored.Audio.Transport);
        Assert.Equal(visual, restored.Visual);
    }

    [Theory]
    [InlineData("")]
    [InlineData("https://youtube.com/watch?v=dQw4w9WgXcQ")]
    [InlineData("bad/id")]
    public async Task ApiRejectsInvalidAudioVideoIds(string videoId)
    {
        using var app = new TestApp();
        using var client = await app.Admin();
        var before = await State(client);
        var command = new CommandEnvelope(Json.Id(), "audio", "setSource",
            JsonSerializer.SerializeToElement(new { source = (AudioSource)new YouTubeAudio(videoId), autoplay = true }, Json.Options),
            before.Revision, before.Desired.Audio.PlaybackGeneration);
        var response = await client.PostAsJsonAsync("/api/commands", command, Json.Options);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        Assert.Equal("invalidVideoId", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Equal(before.Desired, (await State(client)).Desired);
    }

    [Theory]
    [InlineData("defaults")]
    [InlineData("resumeLast")]
    public async Task StartupRestoresYouTubeAudio(string mode)
    {
        using var app = new TestApp();
        var presetId = Json.Id();
        var audio = new AudioState { Source = new YouTubeAudio(VideoId), Transport = "playing", PlaybackGeneration = 4 };
        var checkpoint = new Checkpoint(Validate.Fingerprint(audio.Source), 4, 23, 120, false, null, VideoId, DateTimeOffset.UtcNow);
        await app.Data.Store.Update<StartupSettings>("settings/startup-settings.json", _ => new()
        {
            StartupMode = mode, StartVisualOnBoot = false, StartAudioOnBoot = true, DefaultAudioPresetId = presetId
        });
        await app.Data.Store.Update<CollectionDocument<AudioPreset>>("presets/audio-presets.json", d =>
        {
            d.Items.Add(new(presetId, "YouTube audio", audio.Source, audio.Playback, 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow));
            return d;
        });
        await app.Data.Store.Update<RuntimeDocument>("settings/runtime-state.json", _ => new()
        {
            Desired = new() { Audio = audio }, Checkpoints = new(null, checkpoint)
        });
        using var client = await app.Admin();
        var state = await State(client);
        Assert.Equal(audio.Source, state.Desired.Audio.Source);
        Assert.Equal("playing", state.Desired.Audio.Transport);
        Assert.Null(state.Desired.Visual.Source);
        if (mode == "resumeLast") Assert.Equal(checkpoint, state.Checkpoints.Audio);
    }
}

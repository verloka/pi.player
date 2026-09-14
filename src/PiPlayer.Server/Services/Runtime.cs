using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using PiPlayer.Server.Configuration;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Hubs;

namespace PiPlayer.Server.Services;

public sealed class Runtime(JsonStore store, MediaLibrary library, DependencyCoordinator dependencies, ScreenSessions sessions,
    PiPlayerOptions options, IHubContext<ScreenHub> hub, ILogger<Runtime> logger) : BackgroundService
{
    private readonly SemaphoreSlim gate = new(1);
    private readonly SemaphoreSlim flushGate = new(1);
    private readonly string instance = Json.Id();
    private DesiredState desired = new();
    private Checkpoints checkpoints = new();
    private readonly Dictionary<string, ObservedChannel> observed = [];
    private readonly Dictionary<string, (long Sequence, string Page)> reportSequences = [];
    private readonly Dictionary<string, (string Payload, CommandReceipt Receipt, DateTimeOffset At, string Target, long Generation, string Type, DesiredState Expected, string[] Channels)> receipts = [];
    private long revision, telemetrySequence, dirtyVersion, savedVersion;
    private DateTimeOffset changedAt, checkpointSavedAt, statusPublishedAt;
    private string persistence = "saved";
    private Cause cause = new(null, "startup");
    private Drag? drag;
    private record Drag(string Id, string Owner, long Sequence, long Generation, DateTimeOffset At);
    public bool Ready { get; private set; }
    public string? InitializationError { get; private set; }
    public async Task<StateEnvelope> Snapshot()
    { await gate.WaitAsync(); try { return Envelope(); } finally { gate.Release(); } }
    private StateEnvelope Envelope() => new(instance, revision, desired, new(observed), sessions.Status, persistence, cause, telemetrySequence, checkpoints, store.Warnings.ToArray(), options.EnableExperimentalYouTubeRotation);
    public async Task Initialize(CancellationToken ct)
    {
        try
        {
            await library.Recover(ct);
            var settings = await store.Read<StartupSettings>("settings/startup-settings.json", ct);
            RuntimeDocument? runtime = null;
            if (settings.StartupMode == "resumeLast")
            {
                try { runtime = await store.Read<RuntimeDocument>("settings/runtime-state.json", ct); if (runtime.DocumentRevision == 0) runtime = null; }
                catch (ApiException e) when (e.Code == "storageCorrupt") { await store.PreserveInvalidRuntime(ct); }
                if (runtime != null)
                {
                    try { await ValidateState(runtime.Desired, ct, allowMissing: true); }
                    catch (Exception e) when (e is ApiException or NullReferenceException)
                    { await store.PreserveInvalidRuntime(ct); runtime = null; }
                }
            }
            if (runtime != null)
            {
                desired = runtime.Desired; checkpoints = runtime.Checkpoints;
                revision = 1;
            }
            else
            {
                if (settings.StartupMode == "resumeLast") store.Warnings.Enqueue("No valid saved runtime; using defaults.");
                desired = new() { Background = new(settings.BackgroundColor) };
                if (settings.StartVisualOnBoot && settings.DefaultVisualPresetId != null)
                    try { desired = await ApplyPresets(desired, settings.DefaultVisualPresetId, null, true, ct); }
                    catch (ApiException) { store.Warnings.Enqueue("Visual startup preset unavailable; Visual skipped."); }
                if (settings.StartAudioOnBoot && settings.DefaultAudioPresetId != null)
                    try { desired = await ApplyPresets(desired, null, settings.DefaultAudioPresetId, true, ct); }
                    catch (ApiException) { store.Warnings.Enqueue("Audio startup preset unavailable; Audio skipped."); }
                revision = 1;
            }
            Ready = true;
        }
        catch (Exception e) when (e is ApiException or IOException or JsonException or UnauthorizedAccessException)
        { InitializationError = e is ApiException a ? a.Code : "storageUnavailable"; logger.LogError("Initialization failed: {Code}", InitializationError); }
    }
    public async Task ValidateState(DesiredState state, CancellationToken ct, string? target = null, bool allowMissing = false)
    {
        Validate.Require(state.Visual != null && state.Audio != null && state.Background != null && state.Visual.Transform != null && state.Visual.Playback != null && state.Audio.Playback != null, "invalidState", "Channel objects, geometry, playback and background must be present.", 400);
        Validate.Color(state.Background.Color); Geometry.CheckCircle(state.Circle);
        async Task Check(object? source)
        {
            try { await library.CheckSource(source, ct); }
            catch (ApiException e) when (allowMissing && e.Code is "assetMissing" or "assetNotFound") { store.Warnings.Enqueue("A saved asset is missing. Its references were preserved; other channels remain available."); }
        }
        if (target != "audio") await Check(state.Visual.Source);
        if (target != "visual") await Check(state.Audio.Source);
        if (target != "audio") Geometry.Check(state.Visual.Transform, state.Visual.Source is YouTubeVideo or YouTubePlaylist, options);
        Validate.Number(state.Visual.Playback.Volume, 0, 100, "visual volume"); Validate.Number(state.Audio.Playback.Volume, 0, 100, "audio volume");
        Validate.Number(state.Visual.Playback.PlaybackRate, .25, 4, "playback rate");
        Validate.Number(state.Visual.StartPositionSeconds, 0, 8640000, "visual position"); Validate.Number(state.Audio.StartPositionSeconds, 0, 8640000, "audio position");
        Validate.Require(new[] { "playing", "paused", "stopped" }.Contains(state.Visual.Transport) && new[] { "playing", "paused", "stopped" }.Contains(state.Audio.Transport), "invalidTransport", "Unknown transport.");
        if (state.Audio.Source is RemoteAudioUrl { StreamMode: "live" }) Validate.Require(!state.Audio.Playback.Loop && state.Audio.StartPositionSeconds == 0, "capabilityNotSupported", "Live audio cannot loop or seek.");
    }
    public async Task<DesiredState> ApplyPresets(DesiredState current, string? visualId, string? audioId, bool autoplay, CancellationToken ct)
    {
        if (visualId != null)
        {
            var p = (await store.Read<CollectionDocument<VisualPreset>>("presets/visual-presets.json", ct)).Items.Find(p => p.Id == visualId) ?? throw new ApiException(404, "presetNotFound", "Visual preset not found.");
            current = current with { Visual = new() { Source = p.Source, Visible = p.Visible, Transform = p.Transform, Playback = p.Playback, PlaybackGeneration = current.Visual.PlaybackGeneration + 1, StartPositionSeconds = p.InitialPositionSeconds, Transport = p.Source == null ? "stopped" : autoplay && p.Visible ? "playing" : "paused" } };
            if (p.ReferenceViewport != null && sessions.Status.Descriptor?.Viewport is { } viewport && (viewport.CssWidth != p.ReferenceViewport.CssWidth || viewport.CssHeight != p.ReferenceViewport.CssHeight)) store.Warnings.Enqueue("Preset viewport differs; CSS coordinates preserved. Use Adapt explicitly.");
            // Presets saved before the circle existed carry none and leave the current one alone.
            if (p.Circle != null) current = current with { Circle = p.Circle };
        }
        if (audioId != null)
        {
            var p = (await store.Read<CollectionDocument<AudioPreset>>("presets/audio-presets.json", ct)).Items.Find(p => p.Id == audioId) ?? throw new ApiException(404, "presetNotFound", "Audio preset not found.");
            current = current with { Audio = new() { Source = p.Source, Playback = p.Playback, PlaybackGeneration = current.Audio.PlaybackGeneration + 1, StartPositionSeconds = p.InitialPositionSeconds, Transport = p.Source == null ? "stopped" : autoplay ? "playing" : "paused" } };
        }
        if (visualId != null) await ValidateState(current, ct, "visual");
        if (audioId != null) await ValidateState(current, ct, "audio");
        return current;
    }
    public async Task<CommandReceipt> Dispatch(CommandEnvelope command, string owner, CancellationToken ct = default)
    {
        Validate.Require(Ready, "storageUnavailable", "Backend is not ready.", 503); Validate.Id(command.CommandId);
        ValidatePayload(command);
        bool referenceChange = command.Type is "setSource" or "applyPresets" or "clear";
        if (referenceChange) await dependencies.Gate.WaitAsync(ct);
        StateEnvelope? snapshot = null; CommandReceipt receipt;
        try
        {
            await gate.WaitAsync(ct);
            try
            {
                var payload = JsonSerializer.Serialize(command, Json.Options);
                if (receipts.TryGetValue(command.CommandId, out var previous))
                { Validate.Require(previous.Payload == payload, "commandIdReused", "Command ID was reused with a different payload.", 409); return previous.Receipt; }
                var isDrag = command.Type == "setTransform" && command.InteractionId != null;
                if (isDrag)
                {
                    Validate.Require(command.ExpectedPlaybackGeneration == desired.Visual.PlaybackGeneration && command.ClientSequence is > 0, "stateConflict", "Drag belongs to another generation or has invalid sequence.", 409);
                    if (drag != null && DateTimeOffset.UtcNow - drag.At > TimeSpan.FromSeconds(5)) drag = null;
                    if (drag == null) Validate.Require(command.ExpectedRevision == revision, "stateConflict", "State changed before drag began.", 409);
                    else Validate.Require(drag.Id == command.InteractionId && drag.Owner == owner && command.ClientSequence > drag.Sequence, "stateConflict", "Another or newer drag owns the editor.", 409);
                }
                else if (command.Type != "stopAll") Validate.Require(command.ExpectedRevision == revision, "stateConflict", "State changed. Refresh and apply again.", 409);
                if (command.ExpectedPlaybackGeneration.HasValue && command.Type != "stopAll") Validate.Require(command.ExpectedPlaybackGeneration == (command.Target == "audio" ? desired.Audio.PlaybackGeneration : desired.Visual.PlaybackGeneration), "stateConflict", "Source generation changed.", 409);
                observed.TryGetValue(command.Target, out var currentObserved);
                if (!sessions.Status.Connected || currentObserved?.ReceivedAtUtc < DateTimeOffset.UtcNow.AddSeconds(-5)) currentObserved = null;
                if (currentObserved == null && command.Target == "visual" && checkpoints.Visual?.Ended == true) currentObserved = new() { Status = "ended" };
                if (currentObserved == null && command.Target == "audio" && checkpoints.Audio?.Ended == true) currentObserved = new() { Status = "ended" };
                var next = command.Type == "applyPresets" && command.Target == "system"
                    ? await ApplyPresets(desired, OptionalString(command.Payload, "visualPresetId"), OptionalString(command.Payload, "audioPresetId"), command.Payload.GetProperty("autoplay").GetBoolean(), ct)
                    : Reducer.Apply(desired, command, currentObserved);
                // Source I/O occurs only for reference changes. Continuous geometry commands never read library JSON.
                if (referenceChange && command.Type != "applyPresets") await ValidateState(next, ct, command.Target);
                else
                {
                    if (command.Target == "visual" && command.Type is not ("pause" or "stop" or "setVisible" or "setVolume" or "setMuted")) Geometry.Check(next.Visual.Transform, next.Visual.Source is YouTubeVideo or YouTubePlaylist, options);
                    Validate.Number(next.Visual.Playback.Volume, 0, 100, "volume"); Validate.Number(next.Audio.Playback.Volume, 0, 100, "volume"); Validate.Number(next.Visual.Playback.PlaybackRate, .25, 4, "rate"); Validate.Color(next.Background.Color); Geometry.CheckCircle(next.Circle);
                    if (next.Audio.Source is RemoteAudioUrl { StreamMode: "live" }) Validate.Require(!next.Audio.Playback.Loop, "capabilityNotSupported", "Live audio cannot loop.");
                }
                next = next with { Visual = next.Visual with { Transform = next.Visual.Transform with { Rotation = (next.Visual.Transform.Rotation % 360 + 360) % 360 } } };
                if (next.Visual.PlaybackGeneration != desired.Visual.PlaybackGeneration) { checkpoints = checkpoints with { Visual = null }; observed.Remove("visual"); }
                if (next.Audio.PlaybackGeneration != desired.Audio.PlaybackGeneration) { checkpoints = checkpoints with { Audio = null }; observed.Remove("audio"); }
                string[] affected = command.Target != "system" ? [command.Target] : command.Type == "applyPresets" ? new[] { OptionalString(command.Payload, "visualPresetId") != null ? "visual" : null, OptionalString(command.Payload, "audioPresetId") != null ? "audio" : null }.OfType<string>().ToArray() : ["visual", "audio"];
                desired = next; revision++; cause = new(command.CommandId, "command"); MarkDirty();
                drag = isDrag && !command.Commit ? new(command.InteractionId!, owner, command.ClientSequence!.Value, desired.Visual.PlaybackGeneration, DateTimeOffset.UtcNow) : null;
                receipt = new(command.CommandId, "accepted", instance, revision, sessions.Status.Connected, persistence);
                receipts[command.CommandId] = (payload, receipt, DateTimeOffset.UtcNow, command.Target, command.Target == "audio" ? desired.Audio.PlaybackGeneration : desired.Visual.PlaybackGeneration, command.Type, desired, affected);
                foreach (var key in receipts.Where(p => p.Value.At < DateTimeOffset.UtcNow.AddMinutes(-10)).Select(p => p.Key).ToArray()) receipts.Remove(key);
                while (receipts.Count > 1000) receipts.Remove(receipts.First().Key);
                snapshot = Envelope();
            }
            finally { gate.Release(); }
        }
        finally { if (referenceChange) dependencies.Gate.Release(); }
        await Publish(snapshot);
        if (command.Commit && command.Type is "setTransform" or "pause" or "stop" or "stopAll") await Flush(ct);
        return receipt;
    }
    private static string? OptionalString(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind != JsonValueKind.Null ? v.GetString() : null;
    private static void ValidatePayload(CommandEnvelope command)
    {
        Validate.Require(command.Payload.ValueKind == JsonValueKind.Object, "invalidRequest", "Command payload must be an object.", 400);
        string[] fields = command.Type switch
        {
            "setSource" => ["source", "autoplay"], "setTransform" => ["x", "y", "width", "height", "scale", "rotation", "opacity", "objectFit"],
            "setVolume" or "setMuted" or "setLoop" or "setPlaybackRate" or "setVisible" => ["value"], "seek" => ["seconds"],
            "setBackground" => ["color"], "setCircle" => ["x", "y", "diameter", "color", "visible"], "applyPresets" => ["visualPresetId", "audioPresetId", "autoplay"],
            "play" or "pause" or "resume" or "stop" or "restart" or "clear" or "stopAll" or "playlistNext" or "playlistPrevious" => [],
            _ => throw new ApiException(400, "unknownCommand", "Unknown command type.")
        };
        Validate.Require(command.Payload.EnumerateObject().All(p => fields.Contains(p.Name)), "invalidRequest", "Unexpected command payload field.", 400);
        foreach (var field in fields)
            if (command.Type != "applyPresets" || field == "autoplay") Validate.Require(command.Payload.TryGetProperty(field, out _), "invalidRequest", "Command field missing: " + field, 400);
    }
    private void MarkDirty() { dirtyVersion++; changedAt = DateTimeOffset.UtcNow; persistence = "pending"; }
    public async Task<bool> Report(string connection, PlaybackReport report)
    {
        StateEnvelope envelope; List<CommandReceipt> results = [];
        await gate.WaitAsync();
        try
        {
            if (!sessions.Owns(connection, report.PageSessionId) || report.ServerInstanceId != instance || report.Target is not ("visual" or "audio")) return false;
            var s = report.State; var source = report.Target == "visual" ? (object?)desired.Visual.Source : desired.Audio.Source;
            var gen = report.Target == "visual" ? desired.Visual.PlaybackGeneration : desired.Audio.PlaybackGeneration;
            if (s.PlaybackGeneration != gen || s.SourceFingerprint != Validate.Fingerprint(source) || s.LastAppliedRevision > revision || s.LastAppliedRevision < 0) return false;
            if (reportSequences.TryGetValue(report.Target, out var seq) && seq.Page == report.PageSessionId && seq.Sequence >= report.Sequence) return false;
            Validate.Number(s.PositionSeconds, 0, 8640000, "position"); Validate.Number(s.ActualVolume, 0, 100, "actualVolume");
            Validate.Require(new[] { "idle", "loading", "ready", "playing", "paused", "stopped", "buffering", "ended", "blocked", "error" }.Contains(s.Status), "invalidStatus", "Unknown observed status.");
            reportSequences[report.Target] = (report.Sequence, report.PageSessionId);
            var previousStatus = observed.GetValueOrDefault(report.Target)?.Status;
            s = s with { ReceivedAtUtc = DateTimeOffset.UtcNow }; observed[report.Target] = s; telemetrySequence++;
            if (!s.Capabilities.IsLive && s.Status is "playing" or "paused" or "ended" or "stopped")
            {
                var cp = new Checkpoint(s.SourceFingerprint, gen, s.PositionSeconds, s.DurationSeconds, s.Status == "ended", s.PlaylistIndex, s.CurrentVideoId, DateTimeOffset.UtcNow);
                checkpoints = report.Target == "visual" ? checkpoints with { Visual = cp } : checkpoints with { Audio = cp };
                if (DateTimeOffset.UtcNow - checkpointSavedAt >= TimeSpan.FromSeconds(10) || previousStatus != s.Status && s.Status is "paused" or "stopped" or "ended") { MarkDirty(); checkpointSavedAt = DateTimeOffset.UtcNow; }
            }
            if (s.Status == "ended" && (report.Target == "visual" ? desired.Visual.Transport : desired.Audio.Transport) == "playing")
            {
                desired = report.Target == "visual" ? desired with { Visual = desired.Visual with { Transport = "paused" } } : desired with { Audio = desired.Audio with { Transport = "paused" } };
                revision++; cause = new(null, "internal"); MarkDirty();
            }
            foreach (var (key, pending) in receipts.ToArray())
            {
                if (pending.Receipt.Status != "accepted") continue;
                string? status = null; bool allApplied = true;
                foreach (var target in pending.Channels)
                {
                    var expectedGen = target == "visual" ? pending.Expected.Visual.PlaybackGeneration : pending.Expected.Audio.PlaybackGeneration;
                    var actualGen = target == "visual" ? desired.Visual.PlaybackGeneration : desired.Audio.PlaybackGeneration;
                    if (expectedGen != actualGen) { status = "superseded"; break; }
                    if (!observed.TryGetValue(target, out var actual) || actual.PlaybackGeneration != expectedGen) { allApplied = false; continue; }
                    if (actual.Status is "error" or "blocked") { status = "failed"; break; }
                    if (actual.LastAppliedRevision < pending.Receipt.Revision) { allApplied = false; continue; }
                    var expectedTransport = target == "visual" ? pending.Expected.Visual.Transport : pending.Expected.Audio.Transport;
                    var expectedSource = target == "visual" ? (object?)pending.Expected.Visual.Source : pending.Expected.Audio.Source;
                    var expectedMuted = target == "visual" ? pending.Expected.Visual.Playback.Muted : pending.Expected.Audio.Playback.Muted;
                    var expectedVolume = target == "visual" ? pending.Expected.Visual.Playback.Volume : pending.Expected.Audio.Playback.Volume;
                    bool transportApplied = expectedSource == null ? actual.Status == "idle" : expectedTransport switch
                    { "playing" => actual.Status == "playing", "paused" => actual.Status is "paused" or "ready" or "ended", "stopped" => actual.Status == "stopped" && actual.PositionSeconds < .2, _ => false };
                    var configApplied = expectedSource == null || target == "visual" && !pending.Expected.Visual.Visible || actual.ActualMuted == expectedMuted && Math.Abs(actual.ActualVolume - expectedVolume) < 1.1;
                    if (pending.Type == "setPlaybackRate") configApplied &= Math.Abs(actual.ActualPlaybackRate - pending.Expected.Visual.Playback.PlaybackRate) < .01;
                    if (pending.Type == "seek") configApplied &= Math.Abs(actual.PositionSeconds - (target == "visual" ? pending.Expected.Visual.StartPositionSeconds : pending.Expected.Audio.StartPositionSeconds)) < 2;
                    allApplied &= transportApplied && configApplied;
                }
                if (status == null && allApplied) status = "applied";
                if (status != null) { var receipt = pending.Receipt with { Status = status }; receipts[key] = pending with { Receipt = receipt }; results.Add(receipt); }
            }
            envelope = Envelope();
        }
        finally { gate.Release(); }
        await hub.Clients.Group("admin").SendAsync("playback.updated", envelope);
        if (envelope.Cause.Reason == "internal") await hub.Clients.Group("screen").SendAsync("state.sync", envelope);
        foreach (var result in results) await hub.Clients.Group("admin").SendAsync("command.result", result);
        return true;
    }
    public async Task Publish(StateEnvelope? state = null)
    { state ??= await Snapshot(); await hub.Clients.Group("admin").SendAsync("state.updated", state); await hub.Clients.Group("screen").SendAsync("state.sync", state); }
    public async Task Flush(CancellationToken ct = default)
    {
        await flushGate.WaitAsync(ct);
        try
        {
            RuntimeDocument doc; long version;
            await gate.WaitAsync(ct);
            try { if (dirtyVersion == savedVersion) return; version = dirtyVersion; doc = new() { Desired = desired, Checkpoints = checkpoints, DesiredRevisionAtSave = revision }; }
            finally { gate.Release(); }
            try
            {
                await store.Update<RuntimeDocument>("settings/runtime-state.json", _ => doc, ct: ct);
                await gate.WaitAsync(ct); try { savedVersion = version; persistence = dirtyVersion == version ? "saved" : "pending"; } finally { gate.Release(); }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ApiException)
            { await gate.WaitAsync(ct); try { persistence = "failed"; } finally { gate.Release(); } logger.LogError("Runtime persistence failed; current playback remains in memory."); }
            await hub.Clients.Group("admin").SendAsync("state.updated", await Snapshot(), ct);
        }
        finally { flushGate.Release(); }
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                if (Ready && dirtyVersion != savedVersion && DateTimeOffset.UtcNow - changedAt >= TimeSpan.FromMilliseconds(750)) await Flush(stoppingToken);
                if (DateTimeOffset.UtcNow - statusPublishedAt >= TimeSpan.FromSeconds(5))
                { statusPublishedAt = DateTimeOffset.UtcNow; await hub.Clients.Group("admin").SendAsync("screen.statusChanged", await Snapshot(), stoppingToken); }
                List<CommandReceipt> timedOut = [];
                await gate.WaitAsync(stoppingToken);
                try { foreach (var (id, item) in receipts.ToArray()) if (item.Receipt.Status == "accepted" && DateTimeOffset.UtcNow - item.At > TimeSpan.FromSeconds(30)) { var receipt = item.Receipt with { Status = "timedOut" }; receipts[id] = item with { Receipt = receipt }; timedOut.Add(receipt); } }
                finally { gate.Release(); }
                foreach (var receipt in timedOut) await hub.Clients.Group("admin").SendAsync("command.result", receipt, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
    public override async Task StopAsync(CancellationToken cancellationToken) { await base.StopAsync(cancellationToken); await Flush(cancellationToken); }
}

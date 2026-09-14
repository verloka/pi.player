using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Hubs;
using PiPlayer.Server.Services;
namespace PiPlayer.Server.Endpoints;

public static class CatalogEndpoints
{
    public static long Revision(HttpRequest request)
    {
        var text = request.Headers.IfMatch.ToString().Trim('"');
        if (!long.TryParse(text, out var revision) || revision < 0) throw new ApiException(428, "revisionRequired", "Supply If-Match with the document revision.");
        return revision;
    }
    private static IResult Document<T>(HttpResponse response, T document) where T : Document
    { response.Headers.ETag = $"\"{document.DocumentRevision}\""; return Results.Json(document, Json.Options); }
    public static async Task<List<string>> References(string kind, string id, Runtime runtime, JsonStore store, CancellationToken ct)
    {
        List<string> refs = []; var state = (await runtime.Snapshot()).Desired;
        if (kind == "videos")
        {
            if (state.Visual.Source is LocalVideo v && v.AssetId == id) refs.Add("runtime.visual");
            refs.AddRange((await store.Read<CollectionDocument<VisualPreset>>("presets/visual-presets.json", ct)).Items.Where(p => p.Source is LocalVideo v && v.AssetId == id).Select(p => "visual preset: " + p.Name + " (" + p.Id + ")"));
        }
        else
        {
            if (state.Audio.Source is LocalFile a && a.AssetId == id) refs.Add("runtime.audio");
            refs.AddRange((await store.Read<CollectionDocument<AudioPreset>>("presets/audio-presets.json", ct)).Items.Where(p => p.Source is LocalFile a && a.AssetId == id).Select(p => "audio preset: " + p.Name + " (" + p.Id + ")"));
        }
        return refs;
    }
    public static void MapCatalog(this WebApplication app)
    {
        var api = app.MapGroup("/api");
        api.MapGet("/library/{kind}", async (string kind, HttpResponse response, MediaLibrary library, CancellationToken ct) => Document(response, await library.List(kind, ct)));
        api.MapGet("/library/{kind}/{id}", async (string kind, string id, MediaLibrary library, CancellationToken ct) => await library.Get(kind, id, ct));
        api.MapGet("/library/{kind}/{id}/references", async (string kind, string id, Runtime runtime, JsonStore store, CancellationToken ct) => await References(kind, id, runtime, store, ct));
        api.MapPost("/library/{kind}", async (string kind, HttpRequest request, MediaLibrary library, IHubContext<ScreenHub> hub, CancellationToken ct) =>
        {
            var asset = await library.Upload(kind, request, ct); var doc = await library.List(kind, ct);
            await hub.Clients.Group("admin").SendAsync("library.updated", new { kind, doc.DocumentRevision }, ct);
            return Results.Created($"/api/library/{kind}/{asset.Id}", new { asset, mediaUrl = $"/media/{kind}/{asset.Id}", documentRevision = doc.DocumentRevision });
        });
        api.MapPatch("/library/{kind}/{id}", async (string kind, string id, RenameRequest body, HttpRequest request, HttpResponse response, JsonStore store, CancellationToken ct) =>
        {
            var name = Validate.Name(body.DisplayName);
            var doc = await store.Update<CollectionDocument<Asset>>(MediaLibrary.DocumentName(kind), d =>
            { var index = d.Items.FindIndex(a => a.Id == id); if (index < 0) throw new ApiException(404, "assetNotFound", "Asset not found."); d.Items[index] = d.Items[index] with { DisplayName = name }; return d; }, Revision(request), ct);
            return Document(response, doc);
        });
        api.MapDelete("/library/{kind}/{id}", async (string kind, string id, HttpRequest request, MediaLibrary library, Runtime runtime, JsonStore store, DependencyCoordinator dependencies, CancellationToken ct) =>
        {
            await dependencies.Gate.WaitAsync(ct);
            try { var asset = await library.Get(kind, id, ct); var refs = await References(kind, id, runtime, store, ct); if (refs.Count > 0) throw new ApiException(409, "assetInUse", "Remove these references before deleting the asset.", refs); await library.Delete(kind, asset, Revision(request), ct); return Results.NoContent(); }
            finally { dependencies.Gate.Release(); }
        });
        foreach (var kind in new[] { "visual", "audio" })
        {
            var presetKind = kind; var path = "/presets/" + kind; var file = "presets/" + kind + "-presets.json";
            api.MapGet(path, async (HttpResponse response, JsonStore store, CancellationToken ct) => presetKind == "visual" ? Document(response, await store.Read<CollectionDocument<VisualPreset>>(file, ct)) : Document(response, await store.Read<CollectionDocument<AudioPreset>>(file, ct)));
            api.MapGet(path + "/{id}", async (string id, JsonStore store, CancellationToken ct) =>
            {
                object? item = presetKind == "visual" ? (await store.Read<CollectionDocument<VisualPreset>>(file, ct)).Items.Find(p => p.Id == id) : (await store.Read<CollectionDocument<AudioPreset>>(file, ct)).Items.Find(p => p.Id == id);
                return item == null ? Results.NotFound() : Results.Json(item, Json.Options);
            });
            api.MapPost(path, async (JsonElement body, HttpResponse response, Runtime runtime, JsonStore store, DependencyCoordinator dependencies, CancellationToken ct) => await SavePreset(presetKind, null, body, null, response, runtime, store, dependencies, ct));
            api.MapPut(path + "/{id}", async (string id, JsonElement body, HttpRequest request, HttpResponse response, Runtime runtime, JsonStore store, DependencyCoordinator dependencies, CancellationToken ct) => await SavePreset(presetKind, id, body, Revision(request), response, runtime, store, dependencies, ct));
            api.MapDelete(path + "/{id}", async (string id, HttpRequest request, JsonStore store, DependencyCoordinator dependencies, CancellationToken ct) =>
            {
                await dependencies.Gate.WaitAsync(ct);
                try
                {
                    var startup = await store.Read<StartupSettings>("settings/startup-settings.json", ct);
                    Validate.Require((presetKind == "visual" ? startup.DefaultVisualPresetId : startup.DefaultAudioPresetId) != id, "presetInUse", "Unassign this startup preset first.", 409);
                    if (presetKind == "visual") await store.Update<CollectionDocument<VisualPreset>>(file, d => { if (d.Items.RemoveAll(p => p.Id == id) == 0) throw new ApiException(404, "presetNotFound", "Preset not found."); return d; }, Revision(request), ct);
                    else await store.Update<CollectionDocument<AudioPreset>>(file, d => { if (d.Items.RemoveAll(p => p.Id == id) == 0) throw new ApiException(404, "presetNotFound", "Preset not found."); return d; }, Revision(request), ct);
                    return Results.NoContent();
                }
                finally { dependencies.Gate.Release(); }
            });
        }
        api.MapGet("/settings/startup", async (HttpResponse response, JsonStore store, CancellationToken ct) => Document(response, await store.Read<StartupSettings>("settings/startup-settings.json", ct)));
        api.MapPut("/settings/startup", async (StartupSettings body, HttpRequest request, HttpResponse response, JsonStore store, DependencyCoordinator dependencies, CancellationToken ct) =>
        {
            await dependencies.Gate.WaitAsync(ct);
            try
            {
                Validate.Require(body.StartupMode is "defaults" or "resumeLast", "invalidStartupMode", "Unknown startup mode."); Validate.Color(body.BackgroundColor);
                if (body.DefaultVisualPresetId != null) Validate.Require((await store.Read<CollectionDocument<VisualPreset>>("presets/visual-presets.json", ct)).Items.Any(p => p.Id == body.DefaultVisualPresetId), "presetNotFound", "Visual preset not found.", 404);
                if (body.DefaultAudioPresetId != null) Validate.Require((await store.Read<CollectionDocument<AudioPreset>>("presets/audio-presets.json", ct)).Items.Any(p => p.Id == body.DefaultAudioPresetId), "presetNotFound", "Audio preset not found.", 404);
                return Document(response, await store.Update<StartupSettings>("settings/startup-settings.json", _ => body, Revision(request), ct));
            }
            finally { dependencies.Gate.Release(); }
        });
    }
    private static async Task<IResult> SavePreset(string kind, string? id, JsonElement body, long? expected, HttpResponse response, Runtime runtime, JsonStore store, DependencyCoordinator dependencies, CancellationToken ct)
    {
        await dependencies.Gate.WaitAsync(ct);
        try
        {
            var now = DateTimeOffset.UtcNow; var file = "presets/" + kind + "-presets.json";
            if (kind == "visual")
            {
                var input = Json.Read<VisualPresetInput>(body);
                var state = new DesiredState { Visual = new() { Source = input.Source, Visible = input.Visible, Transform = input.Transform, Playback = input.Playback, StartPositionSeconds = input.InitialPositionSeconds }, Circle = input.Circle ?? new() };
                await runtime.ValidateState(state, ct);
                var preset = new VisualPreset(id ?? Json.Id(), Validate.Name(input.Name), input.Source, input.Visible, input.Transform, input.Playback, input.InitialPositionSeconds, input.ReferenceViewport, now, now, input.Circle);
                return Document(response, await store.Update<CollectionDocument<VisualPreset>>(file, d => { var index = id == null ? -1 : d.Items.FindIndex(p => p.Id == id); if (id != null && index < 0) throw new ApiException(404, "presetNotFound", "Preset not found."); if (index >= 0) d.Items[index] = preset with { CreatedAtUtc = d.Items[index].CreatedAtUtc }; else d.Items.Add(preset); return d; }, expected, ct));
            }
            else
            {
                var input = Json.Read<AudioPresetInput>(body);
                await runtime.ValidateState(new() { Audio = new() { Source = input.Source, Playback = input.Playback, StartPositionSeconds = input.InitialPositionSeconds } }, ct);
                var preset = new AudioPreset(id ?? Json.Id(), Validate.Name(input.Name), input.Source, input.Playback, input.InitialPositionSeconds, now, now);
                return Document(response, await store.Update<CollectionDocument<AudioPreset>>(file, d => { var index = id == null ? -1 : d.Items.FindIndex(p => p.Id == id); if (id != null && index < 0) throw new ApiException(404, "presetNotFound", "Preset not found."); if (index >= 0) d.Items[index] = preset with { CreatedAtUtc = d.Items[index].CreatedAtUtc }; else d.Items.Add(preset); return d; }, expected, ct));
            }
        }
        finally { dependencies.Gate.Release(); }
    }
}
public record RenameRequest(string DisplayName);
public record VisualPresetInput(string Name, VisualSource? Source, bool Visible, Transform Transform, VisualPlayback Playback, double InitialPositionSeconds = 0, Viewport? ReferenceViewport = null, Circle? Circle = null);
public record AudioPresetInput(string Name, AudioSource? Source, Playback Playback, double InitialPositionSeconds = 0);

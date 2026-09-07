using System.Text.Json;
using System.Text.Json.Serialization;
using PiPlayer.Server.Configuration;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Endpoints;
using PiPlayer.Server.Hubs;
using PiPlayer.Server.Services;

var builder = WebApplication.CreateBuilder(args);
var options = (builder.Configuration.GetSection("PiPlayer").Get<PiPlayerOptions>() ?? new()).Normalized();
var paths = new DataPaths(options);
var publicPath = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "wwwroot"));
if (paths.Root.Equals(publicPath, StringComparison.OrdinalIgnoreCase) || paths.Root.StartsWith(publicPath + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("DataPath must not be inside wwwroot.");
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = options.MaxVideoUploadBytes + 65536);
builder.Services.ConfigureHttpJsonOptions(o => { o.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow; o.SerializerOptions.RespectRequiredConstructorParameters = true; });
builder.Services.AddSingleton(options); builder.Services.AddSingleton(paths);
builder.Services.AddSingleton<JsonStore>(); builder.Services.AddSingleton<MediaLibrary>(); builder.Services.AddSingleton<DependencyCoordinator>();
builder.Services.AddSingleton<ScreenSessions>(); builder.Services.AddSingleton<Runtime>();
builder.Services.AddHostedService(p => p.GetRequiredService<Runtime>());
// Open appliance: no accounts, no login, no CSRF. Reachability is bounded by Urls/AllowedHosts and the LAN firewall.
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod().WithExposedHeaders("ETag")));
builder.Services.AddSignalR(o => { o.MaximumReceiveMessageSize = 32768; o.EnableDetailedErrors = false; }).AddJsonProtocol(o => o.PayloadSerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow);
var app = builder.Build();
app.Use(async (context, next) =>
{
    try { await next(); }
    catch (Exception e) when (e is ApiException or JsonException or BadHttpRequestException or IOException or UnauthorizedAccessException or KeyNotFoundException or InvalidOperationException or NotSupportedException)
    {
        if (context.Response.HasStarted) throw;
        var status = e switch { ApiException failure => failure.Status, BadHttpRequestException b => b.StatusCode, IOException => 507, UnauthorizedAccessException => 503, _ => 400 };
        var code = e is ApiException api ? api.Code : status == 413 ? "uploadTooLarge" : status == 507 ? "storageWriteFailed" : "invalidRequest";
        context.Response.StatusCode = status;
        await context.Response.WriteAsJsonAsync(new { type = "about:blank", title = e is ApiException a ? a.Message : "Request could not be completed.", status, code, details = (e as ApiException)?.Details, state = code == "stateConflict" ? await context.RequestServices.GetRequiredService<Runtime>().Snapshot() : null });
    }
});
app.Use(async (context, next) =>
{
    context.Response.Headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' http: https:; connect-src 'self' ws: wss:; frame-src https://www.youtube.com https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
    if (context.Request.Path.StartsWithSegments("/api") || context.Request.Path is { Value: "/admin" or "/screen" or "/index.html" }) context.Response.Headers.CacheControl = "no-store";
    await next();
});
app.UseStatusCodePages(async c =>
{
    var status = c.HttpContext.Response.StatusCode;
    await c.HttpContext.Response.WriteAsJsonAsync(new { type = "about:blank", title = status == 404 ? "Route not found." : "Request rejected.", status, code = status switch { 404 => "notFound", 413 => "uploadTooLarge", _ => "requestRejected" } });
});
app.UseCors();
app.MapGet("/api/system/health", () => new { alive = true });
app.MapGet("/api/system/ready", (Runtime r) => r.Ready ? Results.Ok(new { ready = true }) : Results.Json(new { ready = false, code = r.InitializationError }, statusCode: 503));
app.MapGet("/api/system/state", (Runtime r) => r.Snapshot());
app.MapGet("/api/system/info", (Runtime r) => new { name = "PiPlayer", version = "2.1.0", runtime = Environment.Version.ToString(), hostname = Environment.MachineName, r.Ready, options.MaxVideoUploadBytes, options.MaxAudioUploadBytes, options.RemoteRetrySeconds, options.RemoteRetryBudgetSeconds, options.EnableExperimentalYouTubeRotation });
app.MapGet("/api/system/diagnostics", async (Runtime r, ScreenSessions s, JsonStore store) =>
{
    var state = await r.Snapshot(); var playback = PlaybackReportSummary.Summarize(state);
    return new { version = "2.1.0", runtime = Environment.Version.ToString(), freeBytes = paths.FreeBytes, r.Ready, r.InitializationError, screen = s.Status, persistence = state.Persistence, playback.PlaybackStalled, playback.SoundWaitingForGesture, playback.Channels, warnings = store.Warnings.ToArray() };
});
app.MapGet("/api/system/kiosk-status", async (Runtime r, ScreenSessions s) =>
{
    var status = s.Status; var playback = PlaybackReportSummary.Summarize(await r.Snapshot());
    return new { serverReady = r.Ready, screenConnected = status.Connected, lastHeartbeatAgeSeconds = status.LastHeartbeatAgeSeconds, activePageSessionId = status.Descriptor?.PageSessionId, playback.PlaybackStalled, playback.SoundWaitingForGesture, playback.Channels };
});
// A one-second silent WAV. The screen plays it unmuted at full volume to ask the browser whether audible
// playback is permitted yet: the policy looks at the element, not at the samples, so this makes no sound.
app.MapGet("/media/silence.wav", (HttpResponse response) =>
{
    response.Headers.CacheControl = "private, max-age=86400, immutable";
    return Results.File(Audio.Silence, "audio/wav");
});
app.MapPost("/api/commands", (CommandEnvelope command, HttpContext c, Runtime r, CancellationToken ct) => r.Dispatch(command, Client.Id(c), ct));
app.MapPost("/api/sources/youtube/normalize", (YouTubeRequest body) => Results.Json(Validate.YouTube(body.Url, body.VideoOnly), Json.Options));
app.MapCatalog();
app.MapMethods("/media/{kind}/{id}", ["GET", "HEAD"], async (string kind, string id, HttpResponse response, MediaLibrary library, CancellationToken ct) =>
{
    var asset = await library.Get(kind, id, ct); Validate.Require(asset.Availability == "available", "assetMissing", "Media file is missing.", 404);
    response.Headers.CacheControl = "private, max-age=86400, immutable";
    return Results.File(library.PathFor(kind, asset), asset.ContentType, enableRangeProcessing: true, lastModified: asset.CreatedAtUtc, entityTag: new Microsoft.Net.Http.Headers.EntityTagHeaderValue("\"" + asset.Sha256 + "\""));
});
app.MapHub<ScreenHub>("/hubs/screen");
app.UseDefaultFiles(); app.UseStaticFiles();
app.MapGet("/", () => Results.Redirect("/admin"));
foreach (var route in new[] { "/admin", "/screen" }) app.MapGet(route, (IWebHostEnvironment env) => Results.File(Path.Combine(env.WebRootPath ?? Path.Combine(env.ContentRootPath, "wwwroot"), "index.html"), "text/html"));
await app.Services.GetRequiredService<Runtime>().Initialize(CancellationToken.None);
await app.RunAsync();

public record YouTubeRequest(string Url, bool VideoOnly = false);
public partial class Program;

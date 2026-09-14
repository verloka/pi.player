using System.Text.Json;
using System.Text.Json.Serialization;

namespace PiPlayer.Server.Contracts;

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };
    public static T Read<T>(JsonElement value) => value.Deserialize<T>(Options) ?? throw new ApiException(400, "invalidRequest", "A JSON object is required.");
    public static T Clone<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, Options), Options)!;
    public static string Id() => Guid.CreateVersion7().ToString();
}
public class ApiException(int status, string code, string message, object? details = null) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public object? Details { get; } = details;
}
public class Document
{
    public int SchemaVersion { get; set; } = 2;
    public long DocumentRevision { get; set; }
    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}
public class CollectionDocument<T> : Document { public List<T> Items { get; set; } = []; }

[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(LocalVideo), "localVideo")]
[JsonDerivedType(typeof(YouTubeVideo), "youtubeVideo")]
[JsonDerivedType(typeof(YouTubePlaylist), "youtubePlaylist")]
public abstract record VisualSource;
public record LocalVideo(string AssetId) : VisualSource;
public record YouTubeVideo(string VideoId) : VisualSource;
public record YouTubePlaylist(string PlaylistId, string? InitialVideoId = null) : VisualSource;
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(LocalFile), "localFile")]
[JsonDerivedType(typeof(RemoteAudioUrl), "remoteAudioUrl")]
public abstract record AudioSource;
public record LocalFile(string AssetId) : AudioSource;
public record RemoteAudioUrl(string Url, string StreamMode = "auto") : AudioSource;
public record Transform(double X = 0, double Y = 0, double Width = 640, double Height = 360,
    double Scale = 1, double Rotation = 0, double Opacity = 1, string ObjectFit = "contain");
public record Playback(bool Loop = false, bool Muted = false, double Volume = 50);
public record VisualPlayback(bool Loop = true, bool Muted = true, double Volume = 70, double PlaybackRate = 1);
public record VisualState
{
    public VisualSource? Source { get; init; }
    public bool Visible { get; init; } = true;
    public Transform Transform { get; init; } = new();
    public VisualPlayback Playback { get; init; } = new();
    public string Transport { get; init; } = "stopped";
    public long PlaybackGeneration { get; init; }
    public double StartPositionSeconds { get; init; }
    public int? StartPlaylistIndex { get; init; }
}
public record AudioState
{
    public AudioSource? Source { get; init; }
    public Playback Playback { get; init; } = new();
    public string Transport { get; init; } = "stopped";
    public long PlaybackGeneration { get; init; }
    public double StartPositionSeconds { get; init; }
}
public record Background(string Color = "#000000");
// A disc drawn on the screen above the background and below the video. X and Y offset its centre from the
// centre of the screen, so the default sits in the middle whatever the panel's resolution.
public record Circle(double X = 0, double Y = 0, double Diameter = 400, string Color = "#ffffff", bool Visible = true);
public record DesiredState
{
    public VisualState Visual { get; init; } = new();
    public AudioState Audio { get; init; } = new();
    public Background Background { get; init; } = new();
    public Circle Circle { get; init; } = new();
}
public record Capabilities(bool CanSeek = false, bool CanLoop = false, bool CanSetVolume = true,
    bool CanMute = true, double[]? AvailablePlaybackRates = null, bool CanRotate = false,
    string RotationStatus = "disabled", bool CanSetOpacity = false, bool IsLive = false);
public record PlaybackError(string Code, string Message, int? ProviderCode = null, bool Retryable = false);
public record ObservedChannel
{
    public string Status { get; init; } = "idle";
    public string SourceFingerprint { get; init; } = "none";
    public long PlaybackGeneration { get; init; }
    public double PositionSeconds { get; init; }
    public double? DurationSeconds { get; init; }
    public bool Seekable { get; init; }
    public bool ActualMuted { get; init; }
    public double ActualVolume { get; init; }
    public double ActualPlaybackRate { get; init; } = 1;
    public string? CurrentVideoId { get; init; }
    public int? PlaylistIndex { get; init; }
    public int? PlaylistLength { get; init; }
    public long LastAppliedRevision { get; init; }
    public PlaybackError? Error { get; init; }
    public Capabilities Capabilities { get; init; } = new();
    public DateTimeOffset? ReceivedAtUtc { get; init; }
}
public record Checkpoint(string SourceFingerprint, long PlaybackGeneration, double PositionSeconds,
    double? DurationSeconds, bool Ended, int? PlaylistIndex, string? CurrentVideoId, DateTimeOffset CapturedAtUtc);
public record Checkpoints(Checkpoint? Visual = null, Checkpoint? Audio = null);
public class RuntimeDocument : Document
{
    public long DesiredRevisionAtSave { get; set; }
    public DesiredState Desired { get; set; } = new();
    public Checkpoints Checkpoints { get; set; } = new();
}
public class StartupSettings : Document
{
    public string StartupMode { get; set; } = "defaults";
    public string? DefaultVisualPresetId { get; set; }
    public string? DefaultAudioPresetId { get; set; }
    public bool StartVisualOnBoot { get; set; } = true;
    public bool StartAudioOnBoot { get; set; }
    public string BackgroundColor { get; set; } = "#000000";
}
public record Viewport(double CssWidth, double CssHeight, double DevicePixelRatio = 1);
public record ScreenDescriptor(string DeviceId, string PageSessionId, Viewport Viewport,
    string VisibilityState = "visible", string UserAgent = "");
public record ScreenStatus(bool Connected, bool Stale, ScreenDescriptor? Descriptor, double? LastHeartbeatAgeSeconds);
public record Cause(string? CommandId, string Reason);
public record StateEnvelope(string ServerInstanceId, long Revision, DesiredState Desired,
    Dictionary<string, ObservedChannel> Observed, ScreenStatus Screen, string Persistence, Cause Cause,
    long TelemetrySequence, Checkpoints Checkpoints, string[] Warnings, bool EnableExperimentalYouTubeRotation);
public record CommandEnvelope(string CommandId, string Target, string Type, JsonElement Payload,
    long? ExpectedRevision = null, long? ExpectedPlaybackGeneration = null, string? InteractionId = null,
    long? ClientSequence = null, bool Commit = true);
public record CommandReceipt(string CommandId, string Status, string ServerInstanceId, long Revision,
    bool ScreenOnline, string Persistence);
public record PlaybackReport(string PageSessionId, string ServerInstanceId, string Target, long Sequence, ObservedChannel State);
public record HeartbeatRequest(string PageSessionId);
public record Asset(string Id, string DisplayName, string FileName, string ContentType, long SizeBytes,
    string Sha256, DateTimeOffset CreatedAtUtc, string Availability = "available", double? DurationSeconds = null,
    int? Width = null, int? Height = null, string? VideoCodec = null, string? AudioCodec = null);
public record VisualPreset(string Id, string Name, VisualSource? Source, bool Visible, Transform Transform,
    VisualPlayback Playback, double InitialPositionSeconds, Viewport? ReferenceViewport,
    DateTimeOffset CreatedAtUtc, DateTimeOffset UpdatedAtUtc, Circle? Circle = null);
public record AudioPreset(string Id, string Name, AudioSource? Source, Playback Playback,
    double InitialPositionSeconds, DateTimeOffset CreatedAtUtc, DateTimeOffset UpdatedAtUtc);

using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Diagnostics.CodeAnalysis;
using Microsoft.AspNetCore.WebUtilities;
using PiPlayer.Server.Configuration;
using PiPlayer.Server.Contracts;

namespace PiPlayer.Server.Services;

public static partial class Validate
{
    public static void Require([DoesNotReturnIf(false)] bool condition, string code, string message, int status = 422)
    { if (!condition) throw new ApiException(status, code, message); }
    public static void Number(double n, double min, double max, string name) => Require(double.IsFinite(n) && n >= min && n <= max, "invalidNumber", $"{name} must be between {min} and {max}.");
    public static string Name(string value)
    {
        Require(value != null && value.Trim().Length is >= 1 and <= 200 && !value.Any(char.IsControl), "invalidName", "Name must contain 1–200 printable characters.");
        return value!.Trim();
    }
    public static void Id(string value) => Require(Guid.TryParse(value, out _), "invalidId", "A UUID is required.", 400);
    public static void Color(string value) => Require(value != null && ColorRegex().IsMatch(value), "invalidColor", "Use a six-digit hex color.");
    [GeneratedRegex("^#[0-9a-fA-F]{6}$")] private static partial Regex ColorRegex();
    [GeneratedRegex("^[A-Za-z0-9_-]{11}$")] private static partial Regex VideoRegex();
    [GeneratedRegex("^[A-Za-z0-9_-]{10,150}$")] private static partial Regex PlaylistRegex();
    public static void VideoId(string value) => Require(value != null && VideoRegex().IsMatch(value), "invalidVideoId", "Invalid YouTube video ID.");
    public static void PlaylistId(string value) => Require(value != null && PlaylistRegex().IsMatch(value), "invalidPlaylistId", "Invalid YouTube playlist ID.");
    public static VisualSource YouTube(string value, bool videoOnly = false)
    {
        Require(Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" && string.IsNullOrEmpty(uri.UserInfo) && uri.IsDefaultPort, "invalidYouTubeUrl", "Enter an official YouTube video or playlist URL.");
        Require(new[] { "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be" }.Contains(uri!.Host), "invalidYouTubeHost", "Unsupported YouTube host.");
        var query = QueryHelpers.ParseQuery(uri.Query); string? video = null;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (uri.Host == "youtu.be" && segments.Length == 1) video = segments[0];
        else if (segments.Length == 2 && segments[0] is "embed" or "shorts") video = segments[1];
        else if (uri.AbsolutePath == "/watch") video = query.GetValueOrDefault("v").FirstOrDefault();
        var playlist = query.GetValueOrDefault("list").FirstOrDefault();
        if (video != null) VideoId(video);
        if (!videoOnly && playlist != null) { PlaylistId(playlist); return new YouTubePlaylist(playlist, video); }
        Require(video != null, "invalidYouTubeUrl", "Video ID or playlist ID is missing.");
        return new YouTubeVideo(video!);
    }
    public static string Remote(string value, PiPlayerOptions options)
    {
        Require(value != null && value.Length <= 4096 && Uri.TryCreate(value, UriKind.Absolute, out var _), "invalidRemoteUrl", "Enter an absolute HTTP(S) audio URL up to 4096 characters.");
        var uri = new Uri(value);
        Require(uri.Scheme is "http" or "https" && uri.UserInfo.Length == 0, "invalidRemoteUrl", "Only HTTP(S) without embedded credentials is supported.");
        Require(!new[] { "youtube.com", "youtu.be", "spotify.com", "music.apple.com" }.Any(h => uri.Host == h || uri.Host.EndsWith("." + h)), "servicePageNotAudio", "Service pages are not direct audio sources.");
        Require(!new[] { ".m3u", ".m3u8", ".pls", ".mpd", ".html", ".htm" }.Contains(Path.GetExtension(uri.AbsolutePath).ToLowerInvariant()), "unsupportedAudioUrl", "Playlists and HTML pages are not supported.");
        Require(options.RemoteAudioAllowedHosts.Length == 0 || options.RemoteAudioAllowedHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase), "remoteHostNotAllowed", "Remote host is not allowed.");
        return uri.AbsoluteUri;
    }
    public static string Fingerprint(object? source) => source switch
    {
        LocalVideo v => "localVideo:" + v.AssetId, LocalFile a => "localFile:" + a.AssetId,
        YouTubeVideo v => "youtubeVideo:" + v.VideoId,
        YouTubeAudio a => "youtubeAudio:" + a.VideoId,
        YouTubePlaylist p => "youtubePlaylist:" + p.PlaylistId + ":" + p.InitialVideoId,
        RemoteAudioUrl a => "remoteAudioUrl:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(a.Url + "|" + a.StreamMode))),
        _ => "none"
    };
}
public record Point(double X, double Y);
public record Bounds(double MinX, double MinY, double MaxX, double MaxY);
public static class Geometry
{
    // The layer rotates and scales around its own centre, matching CSS transform-origin: 50% 50%.
    public static Point Centre(Transform t) => new(t.X + t.Width / 2, t.Y + t.Height / 2);
    public static Point[] Corners(Transform t)
    {
        var a = t.Rotation * Math.PI / 180; var c = Math.Cos(a); var s = Math.Sin(a); var o = Centre(t);
        return new[] { new Point(0, 0), new(t.Width, 0), new(t.Width, t.Height), new(0, t.Height) }
            .Select(p => new Point(p.X - t.Width / 2, p.Y - t.Height / 2))
            .Select(p => new Point(o.X + t.Scale * (p.X * c - p.Y * s), o.Y + t.Scale * (p.X * s + p.Y * c))).ToArray();
    }
    public static Bounds Bounds(Transform t)
    { var p = Corners(t); return new(p.Min(p => p.X), p.Min(p => p.Y), p.Max(p => p.X), p.Max(p => p.Y)); }
    public static Transform Check(Transform t, bool youtube, PiPlayerOptions options)
    {
        Validate.Number(t.X, -10000, 10000, "x"); Validate.Number(t.Y, -10000, 10000, "y");
        Validate.Number(t.Width, 1, 4096, "width"); Validate.Number(t.Height, 1, 4096, "height");
        Validate.Number(t.Scale, .01, 8, "scale"); Validate.Number(t.Opacity, 0, 1, "opacity");
        Validate.Require(double.IsFinite(t.Rotation), "invalidNumber", "rotation must be finite.");
        Validate.Require(new[] { "contain", "cover", "fill" }.Contains(t.ObjectFit), "invalidObjectFit", "Unknown object fit.");
        Validate.Require(t.Width * t.Scale <= options.MaxEffectiveDimension && t.Height * t.Scale <= options.MaxEffectiveDimension && t.Width * t.Height * t.Scale * t.Scale <= options.MaxRenderedArea, "resourceLimit", "Scaled dimensions exceed configured rendering limits.");
        t = t with { Rotation = (t.Rotation % 360 + 360) % 360 };
        if (youtube)
        {
            Validate.Require(t.Opacity == 1 && t.ObjectFit == "contain" && t.Width >= 200 && t.Height >= 200 && t.Width * t.Scale >= 200 && t.Height * t.Scale >= 200, "youtubeGeometryInvalid", "YouTube requires an uncropped, opaque viewport at least 200×200 CSS pixels.");
            Validate.Require(t.Rotation == 0 || options.EnableExperimentalYouTubeRotation, "capabilityNotSupported", "Experimental YouTube rotation is disabled.");
            // The player may hang off the edge of the screen. Only its own size and opacity are constrained.
        }
        return t;
    }
    // The circle may hang off the screen like the video; a diameter of 0 simply draws nothing.
    public static Circle CheckCircle(Circle c)
    {
        Validate.Require(c != null, "invalidState", "The circle must be present.", 400);
        Validate.Number(c!.X, -10000, 10000, "circle x"); Validate.Number(c.Y, -10000, 10000, "circle y");
        Validate.Number(c.Diameter, 0, 8192, "circle diameter"); Validate.Color(c.Color);
        return c;
    }
}

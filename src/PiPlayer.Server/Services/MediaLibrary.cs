using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Net.Http.Headers;
using PiPlayer.Server.Configuration;
using PiPlayer.Server.Contracts;

namespace PiPlayer.Server.Services;

public class DeletionDocument : Document { public List<DeletionIntent> Items { get; set; } = []; }
public record DeletionIntent(string Kind, string AssetId, string FileName);
public sealed class MediaLibrary(JsonStore store, DataPaths paths, PiPlayerOptions options)
{
    private readonly SemaphoreSlim uploads = new(options.MaxConcurrentUploads);
    public static string DocumentName(string kind) => kind switch { "videos" => "library/video-library.json", "audio" => "library/audio-library.json", _ => throw new ApiException(404, "notFound", "Unknown library.") };
    public async Task<CollectionDocument<Asset>> List(string kind, CancellationToken ct = default)
    {
        var doc = await store.Read<CollectionDocument<Asset>>(DocumentName(kind), ct);
        var deleting = (await store.Read<DeletionDocument>("trash/deletions.json", ct)).Items.Select(i => i.AssetId).ToHashSet();
        doc.Items = doc.Items.Where(a => !deleting.Contains(a.Id)).Select(a => a with { Availability = File.Exists(PathFor(kind, a)) ? "available" : "missing" }).ToList();
        return doc;
    }
    public string PathFor(string kind, Asset asset)
    {
        DocumentName(kind); Validate.Id(asset.Id);
        Validate.Require(asset.FileName == asset.Id + Path.GetExtension(asset.FileName) && !asset.FileName.Contains('/') && !asset.FileName.Contains('\\'), "invalidStoredPath", "Invalid media metadata.", 503);
        return paths.Get("media/" + kind + "/" + asset.FileName);
    }
    public async Task<Asset> Get(string kind, string id, CancellationToken ct = default)
    { Validate.Id(id); return (await List(kind, ct)).Items.Find(a => a.Id == id) ?? throw new ApiException(404, "assetNotFound", "Asset not found."); }
    public async Task CheckSource(object? source, CancellationToken ct = default)
    {
        switch (source)
        {
            case LocalVideo v: Validate.Require((await Get("videos", v.AssetId, ct)).Availability == "available", "assetMissing", "Video file is missing.", 404); break;
            case LocalFile a: Validate.Require((await Get("audio", a.AssetId, ct)).Availability == "available", "assetMissing", "Audio file is missing.", 404); break;
            case YouTubeVideo v: Validate.VideoId(v.VideoId); break;
            case YouTubePlaylist p: Validate.PlaylistId(p.PlaylistId); if (p.InitialVideoId != null) Validate.VideoId(p.InitialVideoId); break;
            case RemoteAudioUrl a: Validate.Remote(a.Url, options); Validate.Require(new[] { "auto", "file", "live" }.Contains(a.StreamMode), "invalidStreamMode", "Unknown stream mode."); break;
        }
    }
    public async Task<Asset> Upload(string kind, HttpRequest request, CancellationToken ct)
    {
        var name = DocumentName(kind); var limit = kind == "videos" ? options.MaxVideoUploadBytes : options.MaxAudioUploadBytes;
        if (!await uploads.WaitAsync(0, ct)) throw new ApiException(429, "rateLimited", "Another upload is in progress.");
        string? partial = null; string? final = null;
        try
        {
            Validate.Require(paths.FreeBytes >= options.MinFreeDiskBytes + Math.Min(request.ContentLength ?? limit, limit), "insufficientStorage", "Insufficient free space.", 507);
            Validate.Require(MediaTypeHeaderValue.TryParse(request.ContentType, out var media) && media.MediaType == "multipart/form-data", "invalidUpload", "Expected multipart/form-data.", 400);
            var boundary = HeaderUtilities.RemoveQuotes(media!.Boundary).Value;
            Validate.Require(boundary != null && boundary.Length <= 128, "invalidUpload", "Invalid multipart boundary.", 400);
            var reader = new MultipartReader(boundary!, request.Body) { BodyLengthLimit = limit + 65536, HeadersLengthLimit = 16384 };
            Asset? asset = null; string? display = null;
            MultipartSection? section;
            while ((section = await reader.ReadNextSectionAsync(ct)) != null)
            {
                Validate.Require(ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition), "invalidUpload", "Invalid multipart section.", 400);
                var field = HeaderUtilities.RemoveQuotes(disposition!.Name).Value;
                if (disposition.FileName.HasValue || disposition.FileNameStar.HasValue)
                {
                    Validate.Require(field == "file" && asset == null, "invalidUpload", "Exactly one file is allowed.", 400);
                    var filename = HeaderUtilities.RemoveQuotes(disposition.FileNameStar.HasValue ? disposition.FileNameStar : disposition.FileName).Value ?? "";
                    var extension = Path.GetExtension(filename).ToLowerInvariant(); var contentType = Mime(kind, extension);
                    var id = Json.Id(); partial = paths.Get("uploads/" + id + ".partial");
                    long count = 0; using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    var signature = new byte[64]; int signatureLength = 0;
                    await using (var target = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
                    {
                        var buffer = new byte[65536]; int read;
                        while ((read = await section.Body.ReadAsync(buffer, ct)) > 0)
                        {
                            count += read; Validate.Require(count <= limit, "uploadTooLarge", "Upload exceeds the configured byte limit.", 413);
                            Validate.Require(paths.FreeBytes > options.MinFreeDiskBytes, "insufficientStorage", "Free-space reserve reached.", 507);
                            var take = Math.Min(read, signature.Length - signatureLength); buffer.AsSpan(0, take).CopyTo(signature.AsSpan(signatureLength)); signatureLength += take;
                            hash.AppendData(buffer, 0, read); await target.WriteAsync(buffer.AsMemory(0, read), ct);
                        }
                        await target.FlushAsync(ct);
                    }
                    Validate.Require(Signature(extension, signature.AsSpan(0, signatureLength)), "unsupportedMediaType", "File signature does not match the allowed container.", 415);
                    asset = new(id, Validate.Name(Path.GetFileNameWithoutExtension(filename.Replace('\\', '/'))), id + extension, contentType, count, Convert.ToHexStringLower(hash.GetHashAndReset()), DateTimeOffset.UtcNow);
                }
                else
                {
                    Validate.Require(field == "displayName" && display == null, "invalidUpload", "Unexpected multipart field.", 400);
                    var bytes = new byte[1024]; var n = 0;
                    while (n < bytes.Length) { var read = await section.Body.ReadAsync(bytes.AsMemory(n), ct); if (read == 0) break; n += read; }
                    Validate.Require(n < 1024, "invalidName", "Display name is too long.");
                    display = Validate.Name(Encoding.UTF8.GetString(bytes, 0, n));
                }
            }
            Validate.Require(asset != null, "invalidUpload", "File is required.", 400);
            if (display != null) asset = asset! with { DisplayName = display };
            final = PathFor(kind, asset!); File.Move(partial!, final); partial = null;
            await store.Update<CollectionDocument<Asset>>(name, d => { d.Items.Add(asset!); return d; }, ct: ct);
            final = null; return asset!;
        }
        finally { if (partial != null && File.Exists(partial)) File.Delete(partial); if (final != null && File.Exists(final)) File.Delete(final); uploads.Release(); }
    }
    public static string Mime(string kind, string ext) => (kind, ext) switch
    {
        ("videos", ".mp4") => "video/mp4", ("videos", ".webm") => "video/webm",
        ("audio", ".mp3") => "audio/mpeg", ("audio", ".wav") => "audio/wav", ("audio", ".ogg") => "audio/ogg",
        ("audio", ".m4a") => "audio/mp4", ("audio", ".flac") => "audio/flac",
        _ => throw new ApiException(415, "unsupportedMediaType", "Unsupported file extension for this library.")
    };
    public static bool Signature(string ext, ReadOnlySpan<byte> b) => ext switch
    {
        ".mp4" or ".m4a" => b.Length >= 12 && b.Slice(4, 4).SequenceEqual("ftyp"u8),
        ".webm" => b.Length >= 4 && b[..4].SequenceEqual(new byte[] { 0x1a, 0x45, 0xdf, 0xa3 }) && Encoding.ASCII.GetString(b).Contains("webm", StringComparison.Ordinal),
        ".mp3" => b.Length >= 3 && (b[..3].SequenceEqual("ID3"u8) || (b[0] == 255 && (b[1] & 0xe0) == 0xe0)),
        ".wav" => b.Length >= 12 && b[..4].SequenceEqual("RIFF"u8) && b.Slice(8, 4).SequenceEqual("WAVE"u8),
        ".ogg" => b.Length >= 4 && b[..4].SequenceEqual("OggS"u8),
        ".flac" => b.Length >= 4 && b[..4].SequenceEqual("fLaC"u8), _ => false
    };
    // Caller owns DependencyCoordinator until the durable intent and metadata removal complete.
    public async Task Delete(string kind, Asset asset, long expected, CancellationToken ct)
    {
        var doc = await List(kind, ct);
        Validate.Require(doc.DocumentRevision == expected, "documentConflict", "Library changed. Refresh.", 409);
        var intent = new DeletionIntent(kind, asset.Id, asset.FileName);
        await store.Update<DeletionDocument>("trash/deletions.json", d => { d.Items.Add(intent); return d; }, ct: ct);
        await FinishDeletion(intent, ct);
    }
    private async Task FinishDeletion(DeletionIntent intent, CancellationToken ct)
    {
        await store.Update<CollectionDocument<Asset>>(DocumentName(intent.Kind), d => { d.Items.RemoveAll(a => a.Id == intent.AssetId); return d; }, ct: ct);
        var placeholder = new Asset(intent.AssetId, "deleting", intent.FileName, "", 0, "", DateTimeOffset.UtcNow);
        var path = PathFor(intent.Kind, placeholder); var trash = paths.Get("trash/" + intent.FileName);
        if (File.Exists(path)) File.Move(path, trash, true);
        if (File.Exists(trash)) File.Delete(trash);
        await store.Update<DeletionDocument>("trash/deletions.json", d => { d.Items.RemoveAll(i => i.AssetId == intent.AssetId); return d; }, ct: ct);
    }
    public async Task Recover(CancellationToken ct)
    {
        foreach (var i in (await store.Read<DeletionDocument>("trash/deletions.json", ct)).Items) await FinishDeletion(i, ct);
        foreach (var p in Directory.EnumerateFiles(paths.Get("uploads"), "*.partial")) File.Delete(paths.Get("uploads/" + Path.GetFileName(p)));
        foreach (var kind in new[] { "videos", "audio" })
        {
            var doc = await List(kind, ct); var known = doc.Items.Select(a => a.FileName).ToHashSet();
            foreach (var p in Directory.EnumerateFiles(paths.Get("media/" + kind)))
                if (!known.Contains(Path.GetFileName(p))) store.Warnings.Enqueue("Orphan media in " + kind + "; preserved for inspection.");
        }
    }
}

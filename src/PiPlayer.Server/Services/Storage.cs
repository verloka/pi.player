using System.Collections.Concurrent;
using System.Text.Json;
using PiPlayer.Server.Configuration;
using PiPlayer.Server.Contracts;

namespace PiPlayer.Server.Services;

public sealed class DataPaths
{
    public string Root { get; }
    public DataPaths(PiPlayerOptions options)
    {
        Root = Path.GetFullPath(options.DataPath, AppContext.BaseDirectory);
        var publicRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "wwwroot"));
        if (Root.StartsWith(publicRoot, StringComparison.OrdinalIgnoreCase)) throw new IOException("DataPath overlaps public files.");
        foreach (var dir in new[] { "settings", "presets", "library", "media/videos", "media/audio", "uploads", "trash", "diagnostics", "logs" })
            Directory.CreateDirectory(Get(dir));
        var probe = Get(".write-probe"); File.WriteAllText(probe, "ok"); File.Delete(probe);
    }
    public string Get(string relative)
    {
        var path = Path.GetFullPath(Path.Combine(Root, relative));
        if (!path.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Path outside data root.");
        FileSystemInfo? entry = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);
        while (entry != null && entry.FullName.Length >= Root.Length)
        {
            if (entry.Exists && entry.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Links are not allowed in data paths.");
            entry = Directory.GetParent(entry.FullName);
        }
        return path;
    }
    public long FreeBytes => new DriveInfo(Path.GetPathRoot(Root)!).AvailableFreeSpace;
}

public sealed class JsonStore(DataPaths paths, ILogger<JsonStore> logger)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new();
    public ConcurrentQueue<string> Warnings { get; } = new();
    public async Task PreserveInvalidRuntime(CancellationToken ct)
    {
        const string name = "settings/runtime-state.json";
        var gate = locks.GetOrAdd(name, _ => new(1)); await gate.WaitAsync(ct);
        try
        {
            var path = paths.Get(name);
            foreach (var file in new[] { path, path + ".bak" }) if (File.Exists(file)) File.Move(file, file + ".invalid-" + Json.Id());
            Warnings.Enqueue("Invalid resumeLast document preserved for diagnosis; runtime will be saved from defaults.");
        }
        finally { gate.Release(); }
    }
    public async Task<T> Read<T>(string name, CancellationToken ct = default) where T : Document, new()
    {
        var gate = locks.GetOrAdd(name, _ => new(1));
        await gate.WaitAsync(ct);
        try { return await ReadCore<T>(name, ct); } finally { gate.Release(); }
    }
    private async Task<T> Parse<T>(string path, CancellationToken ct) where T : Document
    {
        await using var stream = File.OpenRead(path);
        using var raw = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        if (raw.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("Expected a document object.");
        if (!raw.RootElement.TryGetProperty("schemaVersion", out var version) || version.GetInt32() != 2)
            throw new ApiException(503, "unsupportedSchemaVersion", "Stored schema requires an explicit migration; original files preserved.");
        return raw.RootElement.Deserialize<T>(Json.Options) ?? throw new JsonException("Empty document");
    }
    private async Task<T> ReadCore<T>(string name, CancellationToken ct) where T : Document, new()
    {
        var path = paths.Get(name);
        if (!File.Exists(path))
        {
            if (File.Exists(path + ".bak")) return await Recover<T>(name, path, ct);
            return new T();
        }
        try { return await Parse<T>(path, ct); }
        catch (JsonException) { return await Recover<T>(name, path, ct); }
    }
    private async Task<T> Recover<T>(string name, string path, CancellationToken ct) where T : Document, new()
    {
        if (!File.Exists(path + ".bak")) throw new ApiException(503, "storageCorrupt", "JSON is corrupt and has no backup. Restore a backup; originals are preserved.");
        T recovered;
        try { recovered = await Parse<T>(path + ".bak", ct); }
        catch (JsonException) { throw new ApiException(503, "storageCorrupt", "Both JSON and backup are invalid; restore data manually."); }
        if (File.Exists(path)) File.Copy(path, path + ".corrupt-" + Json.Id());
        var temp = path + "." + Json.Id() + ".tmp";
        File.Copy(path + ".bak", temp); File.Move(temp, path, true);
        Warnings.Enqueue("Recovered " + name + " from backup."); logger.LogWarning("Recovered document {Document} from backup", name);
        return recovered;
    }
    public async Task<T> Update<T>(string name, Func<T, T> update, long? expected = null, CancellationToken ct = default) where T : Document, new()
    {
        var gate = locks.GetOrAdd(name, _ => new(1)); await gate.WaitAsync(ct);
        string? temp = null;
        try
        {
            var current = await ReadCore<T>(name, ct);
            if (expected.HasValue && current.DocumentRevision != expected) throw new ApiException(409, "documentConflict", "Document changed. Refresh before saving.");
            var revision = current.DocumentRevision;
            var next = update(current); next.SchemaVersion = 2; next.DocumentRevision = revision + 1; next.UpdatedAtUtc = DateTimeOffset.UtcNow;
            var path = paths.Get(name); temp = path + "." + Json.Id() + ".tmp";
            await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous | FileOptions.WriteThrough))
            { await JsonSerializer.SerializeAsync(stream, next, Json.Options, ct); await stream.FlushAsync(ct); stream.Flush(true); }
            if (File.Exists(path)) File.Replace(temp, path, path + ".bak", true);
            else File.Move(temp, path);
            return Json.Clone(next);
        }
        finally { if (temp != null && File.Exists(temp)) File.Delete(temp); gate.Release(); }
    }
}

// All reference-changing operations take this gate before runtime/document gates.
public sealed class DependencyCoordinator { public SemaphoreSlim Gate { get; } = new(1); }

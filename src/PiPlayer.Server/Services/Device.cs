using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using PiPlayer.Server.Contracts;
namespace PiPlayer.Server.Services;

public record CommandResult(int ExitCode, string Output, string Error);
public record DeviceStatus(double? VolumePercent, bool? Muted, double? TemperatureCelsius, string? Error);
public record DeviceAudioRequest(double? VolumePercent = null, bool? Muted = null);

// The Pi's own output volume and temperature, set and read by running wpctl and vcgencmd directly. wpctl reaches
// the PipeWire of the desktop session only as that session's user, so configure-kiosk.sh runs the service as it.
public sealed partial class DeviceControl(Func<string, string[], Task<CommandResult?>> run, string thermalZone = "/sys/class/thermal/thermal_zone0/temp")
{
    private const string Sink = "@DEFAULT_AUDIO_SINK@";
    private readonly SemaphoreSlim gate = new(1);
    public DeviceControl() : this(Run) { }

    public async Task<DeviceStatus> Status()
    {
        await gate.WaitAsync();
        try { return await Read(); } finally { gate.Release(); }
    }
    public async Task<DeviceStatus> Change(DeviceAudioRequest request)
    {
        Validate.Require(request.VolumePercent != null || request.Muted != null, "invalidRequest", "Give a volume, a mute state or both.", 400);
        if (request.VolumePercent is { } percent) Validate.Number(percent, 0, 100, "volume");
        await gate.WaitAsync();
        try
        {
            if (request.VolumePercent is { } level) await Wpctl("volumeFailed", "set-volume", Sink, ((int)Math.Round(level)).ToString(CultureInfo.InvariantCulture) + "%");
            if (request.Muted is { } muted) await Wpctl("muteFailed", "set-mute", Sink, muted ? "1" : "0");
            return await Read();
        }
        finally { gate.Release(); }
    }
    private async Task Wpctl(string code, params string[] args)
    {
        var result = await run("wpctl", args);
        if (result is not { ExitCode: 0 }) throw new ApiException(503, code, "wpctl: " + Describe(result));
    }
    private async Task<DeviceStatus> Read()
    {
        var volume = await run("wpctl", ["get-volume", Sink]);
        var match = volume is { ExitCode: 0 } ? VolumeLine().Match(volume.Output) : Match.Empty;
        var temperature = await Temperature();
        return match.Success
            ? new(Math.Round(double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) * 100), volume!.Output.Contains("[MUTED]"), temperature, null)
            : new(null, null, temperature, "wpctl: " + Describe(volume));
    }
    private async Task<double?> Temperature()
    {
        var result = await run("vcgencmd", ["measure_temp"]);
        var match = result is { ExitCode: 0 } ? TemperatureLine().Match(result.Output) : Match.Empty;
        if (match.Success) return double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
        // vcgencmd needs the video group; the kernel's thermal zone is readable by everyone.
        try { return int.Parse(File.ReadAllText(thermalZone).Trim(), CultureInfo.InvariantCulture) / 1000.0; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or FormatException or OverflowException) { return null; }
    }
    private static string Describe(CommandResult? result)
    {
        if (result == null) return "not available (missing or not responding)";
        var text = result.Error.Trim().Length > 0 ? result.Error.Trim() : result.Output.Trim();
        return text.Length > 0 ? text.Split('\n')[0] : "exit code " + result.ExitCode;
    }
    private static async Task<CommandResult?> Run(string file, string[] args)
    {
        var info = new ProcessStartInfo(file) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var arg in args) info.ArgumentList.Add(arg);
        Process? process;
        try { process = Process.Start(info); }
        catch (Win32Exception) { return null; }
        if (process == null) return null;
        using (process)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try
            {
                var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
                var error = process.StandardError.ReadToEndAsync(timeout.Token);
                await process.WaitForExitAsync(timeout.Token);
                return new(process.ExitCode, await output, await error);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(true); } catch (InvalidOperationException) { }
                return null;
            }
        }
    }
    [GeneratedRegex(@"Volume:\s*([0-9]+(?:\.[0-9]+)?)")] private static partial Regex VolumeLine();
    [GeneratedRegex(@"temp=(-?[0-9]+(?:\.[0-9]+)?)")] private static partial Regex TemperatureLine();
}

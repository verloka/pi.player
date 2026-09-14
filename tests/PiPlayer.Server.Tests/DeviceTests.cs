using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Services;
using Xunit;
namespace PiPlayer.Server.Tests;

public class DeviceTests
{
    // wpctl and vcgencmd answering the way they do on a Pi, with a volume that set-volume and set-mute really change.
    private sealed class Pi
    {
        public double Volume = .42;
        public bool Muted, PipeWireDown, NoVcgencmd;
        public readonly List<string> Calls = [];
        public Task<CommandResult?> Run(string file, string[] args)
        {
            Calls.Add(file + " " + string.Join(' ', args));
            CommandResult? result = (file, args[0]) switch
            {
                ("wpctl", _) when PipeWireDown => new(1, "", "Could not connect to PipeWire\n"),
                ("wpctl", "get-volume") => new(0, "Volume: " + Volume.ToString("0.00", CultureInfo.InvariantCulture) + (Muted ? " [MUTED]" : "") + "\n", ""),
                ("wpctl", "set-volume") => Done(() => Volume = int.Parse(args[2].TrimEnd('%'), CultureInfo.InvariantCulture) / 100.0),
                ("wpctl", "set-mute") => Done(() => Muted = args[2] == "1"),
                ("vcgencmd", "measure_temp") when !NoVcgencmd => new(0, "temp=52.1'C\n", ""),
                _ => null
            };
            return Task.FromResult(result);
        }
        private static CommandResult Done(Action change) { change(); return new(0, "", ""); }
    }

    [Fact] public async Task ReadsVolumeMuteAndTemperatureFromTheDevice()
    {
        var pi = new Pi { Muted = true };
        Assert.Equal(new DeviceStatus(42, true, 52.1, null), await new DeviceControl(pi.Run).Status());
        Assert.Equal(new[] { "wpctl get-volume @DEFAULT_AUDIO_SINK@", "vcgencmd measure_temp" }, pi.Calls);
    }
    [Fact] public async Task SetsVolumeAndMuteByRunningWpctl()
    {
        var pi = new Pi(); var device = new DeviceControl(pi.Run);
        Assert.Equal(new DeviceStatus(30, false, 52.1, null), await device.Change(new(VolumePercent: 30)));
        Assert.Contains("wpctl set-volume @DEFAULT_AUDIO_SINK@ 30%", pi.Calls);
        Assert.Equal(new DeviceStatus(30, true, 52.1, null), await device.Change(new(Muted: true)));
        Assert.Contains("wpctl set-mute @DEFAULT_AUDIO_SINK@ 1", pi.Calls);
    }
    [Fact] public async Task SaysWhyWhenWpctlCannotReachPipeWire()
    {
        var pi = new Pi { PipeWireDown = true }; var device = new DeviceControl(pi.Run);
        var status = await device.Status();
        Assert.Null(status.VolumePercent); Assert.Equal(52.1, status.TemperatureCelsius); Assert.Contains("Could not connect to PipeWire", status.Error);
        var failure = await Assert.ThrowsAsync<ApiException>(() => device.Change(new(VolumePercent: 30)));
        Assert.Equal((503, "volumeFailed"), (failure.Status, failure.Code)); Assert.Contains("Could not connect to PipeWire", failure.Message);
    }
    [Fact] public async Task TemperatureFallsBackToTheKernelThermalZone()
    {
        using var temp = new TempData(); Directory.CreateDirectory(temp.Root);
        var zone = Path.Combine(temp.Root, "temp"); await File.WriteAllTextAsync(zone, "51234\n");
        var pi = new Pi { NoVcgencmd = true };
        Assert.Equal(51.234, (await new DeviceControl(pi.Run, zone).Status()).TemperatureCelsius!.Value, 3);
        Assert.Null((await new DeviceControl(pi.Run, zone + ".missing").Status()).TemperatureCelsius);
    }
    [Fact] public async Task RejectsAnEmptyOrOutOfRangeChangeWithoutRunningAnything()
    {
        var pi = new Pi(); var device = new DeviceControl(pi.Run);
        Assert.Equal("invalidRequest", (await Assert.ThrowsAsync<ApiException>(() => device.Change(new()))).Code);
        Assert.Equal("invalidNumber", (await Assert.ThrowsAsync<ApiException>(() => device.Change(new(VolumePercent: 150)))).Code);
        Assert.Empty(pi.Calls);
    }
    [Fact] public async Task DeviceEndpointsAnswerOnAnyMachine()
    {
        using var app = new TestApp(); using var client = await app.Admin();
        // Off the Pi wpctl is missing; the status still answers and carries the reason.
        Assert.NotNull(await client.GetFromJsonAsync<DeviceStatus>("/api/device", Json.Options));
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/device/audio", new { })).StatusCode);
    }
}

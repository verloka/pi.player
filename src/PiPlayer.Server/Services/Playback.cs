using PiPlayer.Server.Contracts;
namespace PiPlayer.Server.Services;

// A one-second silent 8 kHz mono PCM WAV, built once. The screen uses it as an autoplay probe.
public static class Audio
{
    public static byte[] Silence { get; } = Build();
    private static byte[] Build()
    {
        const int rate = 8000, seconds = 1, bytesPerSample = 2;
        var data = rate * seconds * bytesPerSample;
        var wav = new byte[44 + data];
        void Ascii(int at, string text) { for (var i = 0; i < text.Length; i++) wav[at + i] = (byte)text[i]; }
        void Int32(int at, int value) => BitConverter.TryWriteBytes(wav.AsSpan(at, 4), value);
        void Int16(int at, short value) => BitConverter.TryWriteBytes(wav.AsSpan(at, 2), value);
        Ascii(0, "RIFF"); Int32(4, 36 + data); Ascii(8, "WAVE");
        Ascii(12, "fmt "); Int32(16, 16); Int16(20, 1); Int16(22, 1);
        Int32(24, rate); Int32(28, rate * bytesPerSample); Int16(32, bytesPerSample); Int16(34, 16);
        Ascii(36, "data"); Int32(40, data);
        return wav;
    }
}

public record ChannelPlayback(string Target, string Intent, string Status, string? ErrorCode, string? ErrorMessage);

// What an operator with only SSH needs to know: is a channel supposed to be playing, and is it?
public static class PlaybackReportSummary
{
    public static (bool PlaybackStalled, bool SoundWaitingForGesture, ChannelPlayback[] Channels) Summarize(StateEnvelope state)
    {
        ChannelPlayback Channel(string target)
        {
            var intent = target == "visual" ? state.Desired.Visual.Transport : state.Desired.Audio.Transport;
            var source = target == "visual" ? (object?)state.Desired.Visual.Source : state.Desired.Audio.Source;
            var observed = state.Observed.GetValueOrDefault(target);
            return new(target, source == null ? "none" : intent, observed?.Status ?? "unreported", observed?.Error?.Code, observed?.Error?.Message);
        }
        var channels = new[] { Channel("visual"), Channel("audio") };
        // Stalled: playback was asked for and the browser refused it. Content errors are excluded on
        // purpose — restarting the kiosk cannot fix a bad codec, so they must not trigger one.
        var stalled = channels.Any(c => c.Intent == "playing" && c.Status == "blocked");
        var silent = channels.Any(c => c.ErrorCode == "autoplayMuted");
        return (stalled, silent, channels);
    }
}

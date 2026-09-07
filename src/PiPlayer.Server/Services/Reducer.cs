using System.Text.Json;
using PiPlayer.Server.Contracts;
namespace PiPlayer.Server.Services;

public static class Reducer
{
    public static DesiredState Apply(DesiredState state, CommandEnvelope command, ObservedChannel? observed)
    {
        var p = command.Payload; var v = state.Visual; var a = state.Audio;
        bool visual = command.Target == "visual";
        double Number() => p.GetProperty("value").GetDouble();
        bool Flag() => p.GetProperty("value").GetBoolean();
        var transport = visual ? v.Transport : a.Transport;
        var generation = visual ? v.PlaybackGeneration : a.PlaybackGeneration;
        var position = visual ? v.StartPositionSeconds : a.StartPositionSeconds;
        if (command.Type == "stopAll" && command.Target == "system") return state with
        {
            Visual = v with { Transport = "stopped", StartPositionSeconds = 0, PlaybackGeneration = v.PlaybackGeneration + 1 },
            Audio = a with { Transport = "stopped", StartPositionSeconds = 0, PlaybackGeneration = a.PlaybackGeneration + 1 }
        };
        if (command.Type == "setBackground" && command.Target == "system") return state with { Background = new(p.GetProperty("color").GetString()!) };
        Validate.Require(command.Target is "visual" or "audio", "invalidTarget", "Unknown command target.", 400);
        if (new[] { "play", "resume", "pause", "restart", "seek" }.Contains(command.Type))
            Validate.Require(visual ? v.Source != null : a.Source != null, "sourceNotSelected", "Choose a source first.");
        switch (command.Type)
        {
            case "setSource":
                var autoplay = p.GetProperty("autoplay").GetBoolean();
                if (visual) { var source = p.GetProperty("source").ValueKind == JsonValueKind.Null ? null : Json.Read<VisualSource>(p.GetProperty("source")); if (source is YouTubeVideo or YouTubePlaylist) Validate.Require(v.Playback.PlaybackRate == 1, "capabilityNotSupported", "Set playback rate to 1 before choosing a new YouTube source; available rates are confirmed after load."); v = v with { Source = source, Visible = true, StartPlaylistIndex = null }; }
                else { var source = p.GetProperty("source").ValueKind == JsonValueKind.Null ? null : Json.Read<AudioSource>(p.GetProperty("source")); a = a with { Source = source }; }
                generation++; position = 0; transport = autoplay ? "playing" : "paused"; break;
            case "play":
                if (transport == "stopped" || observed?.Status == "ended") { generation++; position = 0; }
                transport = "playing"; if (visual) v = v with { Visible = true }; break;
            case "resume": transport = "playing"; if (visual) v = v with { Visible = true }; break;
            case "pause": transport = "paused"; break;
            case "stop": generation++; position = 0; transport = "stopped"; break;
            case "restart": generation++; position = 0; transport = "playing"; if (visual) v = v with { Visible = true }; break;
            case "seek":
                Validate.Require(observed?.Capabilities.CanSeek == true, "capabilityNotSupported", "Seek is not confirmed by the active player.");
                position = p.GetProperty("seconds").GetDouble(); Validate.Number(position, 0, observed!.DurationSeconds ?? 8640000, "seek"); generation++; break;
            case "setVolume": if (visual) v = v with { Playback = v.Playback with { Volume = Number() } }; else a = a with { Playback = a.Playback with { Volume = Number() } }; break;
            case "setMuted": if (visual) v = v with { Playback = v.Playback with { Muted = Flag() } }; else a = a with { Playback = a.Playback with { Muted = Flag() } }; break;
            case "setLoop":
                if (Flag() && observed?.Capabilities.IsLive == true) throw new ApiException(422, "capabilityNotSupported", "Live media cannot loop.");
                if (visual) v = v with { Playback = v.Playback with { Loop = Flag() } }; else a = a with { Playback = a.Playback with { Loop = Flag() } }; break;
            case "setPlaybackRate" when visual:
                var rate = Number();
                if (v.Source is YouTubeVideo or YouTubePlaylist && rate != 1) Validate.Require(observed?.Capabilities.AvailablePlaybackRates?.Contains(rate) == true, "capabilityNotSupported", "Rate is not supported by the current provider.");
                v = v with { Playback = v.Playback with { PlaybackRate = rate } }; break;
            case "setTransform" when visual: v = v with { Transform = Json.Read<Transform>(p) }; break;
            case "setVisible" when visual: v = v with { Visible = Flag() }; if (!v.Visible) transport = "paused"; break;
            case "clear" when visual: v = v with { Source = null }; generation++; position = 0; transport = "stopped"; break;
            case "playlistNext" or "playlistPrevious" when visual:
                Validate.Require(v.Source is YouTubePlaylist && observed?.PlaylistIndex != null && observed.PlaylistLength > 0, "screenUnavailableForOperation", "A fresh playlist context is required.", 503);
                var index = observed!.PlaylistIndex!.Value + (command.Type == "playlistNext" ? 1 : -1); var length = observed.PlaylistLength!.Value;
                Validate.Require(v.Playback.Loop || index >= 0 && index < length, "playlistBoundary", "End of playlist.");
                v = v with { StartPlaylistIndex = (index + length) % length }; generation++; position = 0; break;
            default: throw new ApiException(400, "unknownCommand", "Unsupported command.");
        }
        if (visual) v = v with { Transport = v.Source == null ? "stopped" : transport, PlaybackGeneration = generation, StartPositionSeconds = position };
        else a = a with { Transport = a.Source == null ? "stopped" : transport, PlaybackGeneration = generation, StartPositionSeconds = position };
        return state with { Visual = v, Audio = a };
    }
}

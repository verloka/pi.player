using Microsoft.AspNetCore.SignalR;
using PiPlayer.Server.Contracts;
using PiPlayer.Server.Services;
namespace PiPlayer.Server.Hubs;

// Groups separate the control panel from the screen renderer. They are routing labels, not permissions.
public sealed class ScreenHub(Runtime runtime, ScreenSessions sessions) : Hub
{
    public async Task<StateEnvelope> RegisterAdmin() { await Groups.AddToGroupAsync(Context.ConnectionId, "admin"); return await runtime.Snapshot(); }
    public async Task<object> RegisterScreen(ScreenDescriptor request)
    {
        var accepted = sessions.Register(Context.ConnectionId, request);
        if (accepted) await Groups.AddToGroupAsync(Context.ConnectionId, "screen");
        await Clients.Group("admin").SendAsync("screen.statusChanged", await runtime.Snapshot());
        return new { accepted, code = accepted ? (string?)null : "screenAlreadyConnected", state = accepted ? await runtime.Snapshot() : null };
    }
    public async Task<StateEnvelope> ScreenReady(HeartbeatRequest request)
    { if (!sessions.Owns(Context.ConnectionId, request.PageSessionId)) throw new HubException("screenLeaseExpired"); return await runtime.Snapshot(); }
    public Task<CommandReceipt> SubmitCommand(CommandEnvelope command) => runtime.Dispatch(command, Context.ConnectionId, Context.ConnectionAborted);
    public Task<bool> ReportPlayback(PlaybackReport report) => runtime.Report(Context.ConnectionId, report);
    public bool ReportViewport(ScreenDescriptor descriptor) { sessions.Viewport(Context.ConnectionId, descriptor); return true; }
    public bool Heartbeat(HeartbeatRequest request) => sessions.Heartbeat(Context.ConnectionId, request.PageSessionId);
    public Task<StateEnvelope> RequestState() => runtime.Snapshot();
    public override async Task OnDisconnectedAsync(Exception? exception)
    { sessions.Disconnect(Context.ConnectionId); await Clients.Group("admin").SendAsync("screen.statusChanged", await runtime.Snapshot()); await base.OnDisconnectedAsync(exception); }
}

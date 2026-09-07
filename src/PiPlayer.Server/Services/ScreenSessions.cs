using PiPlayer.Server.Contracts;
namespace PiPlayer.Server.Services;

public sealed class ScreenSessions
{
    private readonly object gate = new();
    private string? connection;
    private ScreenDescriptor? descriptor;
    private DateTimeOffset heartbeat;
    public ScreenStatus Status { get { lock (gate) { var age = descriptor == null ? (double?)null : (DateTimeOffset.UtcNow - heartbeat).TotalSeconds; return new(connection != null && age < 20, age is >= 10, descriptor, age); } } }
    public bool Register(string id, ScreenDescriptor value)
    {
        CheckDescriptor(value);
        lock (gate)
        {
            if (connection != null && (DateTimeOffset.UtcNow - heartbeat).TotalSeconds < 20 && descriptor?.PageSessionId != value.PageSessionId) return false;
            connection = id; descriptor = value; heartbeat = DateTimeOffset.UtcNow; return true;
        }
    }
    public bool Owns(string id, string page) { lock (gate) return connection == id && descriptor?.PageSessionId == page && (DateTimeOffset.UtcNow - heartbeat).TotalSeconds < 20; }
    public bool Heartbeat(string id, string page) { lock (gate) { if (!Owns(id, page)) return false; heartbeat = DateTimeOffset.UtcNow; return true; } }
    public void Viewport(string id, ScreenDescriptor value) { CheckDescriptor(value); lock (gate) { Validate.Require(Owns(id, value.PageSessionId), "screenLeaseExpired", "Register the screen again.", 409); descriptor = value; } }
    public void Disconnect(string id) { lock (gate) { if (connection == id) connection = null; } }
    public static void CheckDescriptor(ScreenDescriptor d)
    {
        Validate.Require(d.DeviceId == "primary", "invalidDevice", "Only primary screen is supported."); Validate.Id(d.PageSessionId);
        Validate.Number(d.Viewport.CssWidth, 1, 16384, "viewport width"); Validate.Number(d.Viewport.CssHeight, 1, 16384, "viewport height");
        Validate.Number(d.Viewport.DevicePixelRatio, .1, 16, "DPR"); Validate.Require(d.UserAgent.Length <= 1024, "invalidDescriptor", "User agent too long.");
    }
}

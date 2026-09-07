namespace PiPlayer.Server.Services;

// Editor identity only: it arbitrates who owns an in-flight drag. It grants no rights and is never a credential.
public static class Client
{
    public const string HeaderName = "X-PiPlayer-Client-Id";
    public static string Id(HttpContext context)
    {
        var value = context.Request.Headers[HeaderName].ToString();
        return value.Length is > 0 and <= 64 && !value.Any(char.IsControl) ? value : "anonymous";
    }
}

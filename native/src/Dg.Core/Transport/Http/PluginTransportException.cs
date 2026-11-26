namespace Dg.Core.Transport.Http;

public static class PluginTransportCodes
{
    public const string Timeout = "timeout";
    public const string Auth = "auth";
    public const string Refused = "refused";
    public const string Oversize = "oversize";
    public const string Unreachable = "unreachable";
    public const string Plugin = "plugin";
}

public sealed class PluginTransportException(string code, string message) : Exception($"dg plugin: {message}")
{
    public string Code { get; } = code;
}

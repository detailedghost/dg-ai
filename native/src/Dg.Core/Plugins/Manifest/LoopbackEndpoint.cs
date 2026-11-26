using System.Net;

namespace Dg.Core.Plugins.Manifest;

internal static class LoopbackEndpoint
{
    private const string Localhost = "localhost";

    public static bool IsLoopbackHost(string host) =>
        host.Equals("127.0.0.1", StringComparison.Ordinal)
        || host.Equals(Localhost, StringComparison.OrdinalIgnoreCase)
        || host is "::1" or "[::1]";

    public static bool TryParse(string endpoint, out IPEndPoint parsed)
    {
        var colon = endpoint.LastIndexOf(':');
        var named = colon > 0 && endpoint.AsSpan(0, colon).Equals(Localhost, StringComparison.OrdinalIgnoreCase);
        return IPEndPoint.TryParse(named ? $"127.0.0.1{endpoint.AsSpan(colon)}" : endpoint, out parsed!);
    }
}

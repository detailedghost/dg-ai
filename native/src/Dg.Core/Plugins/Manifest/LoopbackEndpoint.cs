using System.Collections.Frozen;
using System.Net;

namespace Dg.Core.Plugins.Manifest;

internal static class LoopbackEndpoint
{
    private const string Localhost = "localhost";

    private static readonly FrozenSet<string> Hosts = FrozenSet.ToFrozenSet(
        ["127.0.0.1", Localhost, "::1", "[::1]"],
        StringComparer.OrdinalIgnoreCase
    );

    public static bool IsLoopbackHost(string host) => Hosts.Contains(host);

    public static bool TryParse(string endpoint, out IPEndPoint parsed)
    {
        var colon = endpoint.LastIndexOf(':');
        var named = colon > 0 && endpoint.AsSpan(0, colon).Equals(Localhost, StringComparison.OrdinalIgnoreCase);
        return IPEndPoint.TryParse(named ? $"127.0.0.1{endpoint.AsSpan(colon)}" : endpoint, out parsed!);
    }
}

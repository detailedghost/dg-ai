using System.Net;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Http;

namespace Dg.Core.Transport.Tcp;

public static class TcpEndpointGuard
{
    public static IPEndPoint Resolve(PluginManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (manifest.Transport != PluginTransportKind.Tcp)
            throw Refuse(manifest, "the manifest does not use the tcp transport", "use the tcp transport in plugin.toml");
        if (manifest.Remote)
            throw Refuse(manifest, "tcp is local only", "use the http transport with https for a remote plugin");
        if (manifest.Endpoint is not { } endpoint || !LoopbackEndpoint.TryParse(endpoint, out var parsed) || parsed.Port is < 1 or > 65535)
            throw Refuse(manifest, "the endpoint must be a loopback ip:port", "set endpoint to 127.0.0.1:<port> in plugin.toml");
        if (!IPAddress.IsLoopback(parsed.Address))
            throw Refuse(manifest, $"endpoint host {parsed.Address} is not loopback", "use the http transport with https for a remote plugin");
        return parsed;
    }

    private static PluginTransportException Refuse(PluginManifest manifest, string reason, string next) =>
        new(PluginTransportCodes.Refused, $"{manifest.Name}: tcp transport refused: {reason}. Next: {next}.");
}

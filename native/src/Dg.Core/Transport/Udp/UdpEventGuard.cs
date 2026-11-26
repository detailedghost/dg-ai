using System.Net;
using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;

namespace Dg.Core.Transport.Udp;

public static class UdpEventGuard
{
    public static IPEndPoint Resolve(PluginManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (manifest.Transport != PluginTransportKind.Udp)
            throw Refuse(manifest, "the manifest does not use the udp transport");
        if (manifest.Kind == PluginKind.Hook)
            throw Refuse(manifest, "a hook needs a reply and udp carries events only");
        if (manifest.Remote)
            throw Refuse(manifest, "udp is loopback only");
        if (manifest.Endpoint is not { } endpoint || !LoopbackEndpoint.TryParse(endpoint, out var parsed))
            throw Refuse(manifest, "the endpoint must be a loopback ip:port");
        if (!IPAddress.IsLoopback(parsed.Address) || parsed.Port is < 1 or > 65535)
            throw Refuse(manifest, "the endpoint must be a loopback ip:port");
        return parsed;
    }

    private static PluginContractException Refuse(PluginManifest manifest, string reason) =>
        new(
            "udp-refused",
            $"dg plugin: {manifest.Name}: udp transport refused: {reason}. Next: use the ipc, tcp or http transport for request and reply plugins."
        );
}

using System.Collections.Frozen;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;

namespace Dg.Core.Transport.Http;

internal static class HttpEndpoint
{
    private static readonly FrozenSet<string> LoopbackHosts = FrozenSet.ToFrozenSet(
        ["127.0.0.1", "localhost", "::1", "[::1]"],
        StringComparer.OrdinalIgnoreCase
    );

    public static FrozenDictionary<string, Uri> Resolve(PluginManifest manifest, bool allowRemote)
    {
        var name = manifest.Name;
        if (manifest.Transport != PluginTransportKind.Http || manifest.Endpoint is null)
            throw Refused(name, "plugin is not on the http transport with an endpoint. Next: use the http transport in plugin.toml.");
        if (!Uri.TryCreate(manifest.Endpoint, UriKind.Absolute, out var url))
            throw Refused(name, "endpoint is not a URL. Next: fix endpoint in plugin.toml.");
        if (url.UserInfo.Length > 0)
            throw Refused(
                name,
                $"endpoint must not hold credentials. Next: store the token with dg credentials set {PluginRoutes.TokenCredential(name)}."
            );
        if (url.Query.Length > 0 || url.Fragment.Length > 0)
            throw Refused(name, "endpoint must not hold a query or fragment. Next: remove them from endpoint in plugin.toml.");

        if (manifest.Remote)
        {
            if (!allowRemote)
                throw Refused(
                    name,
                    $"plugin is remote but plugins.{name}.allow_remote is not true. Next: run dg config set plugins.{name}.allow_remote true if you trust {url.Authority}."
                );
            if (url.Scheme != Uri.UriSchemeHttps)
                throw Refused(name, "a remote endpoint must use https. Next: change endpoint to https in plugin.toml.");
        }
        else
        {
            if (url.Scheme != Uri.UriSchemeHttp && url.Scheme != Uri.UriSchemeHttps)
                throw Refused(name, "endpoint must be an http or https URL. Next: fix endpoint in plugin.toml.");
            if (!LoopbackHosts.Contains(url.Host))
                throw Refused(
                    name,
                    $"endpoint host {url.Host} is not loopback. Next: set remote = true in plugin.toml and allow_remote = true in config.toml."
                );
        }

        var prefix = url.GetLeftPart(UriPartial.Authority) + url.AbsolutePath.TrimEnd('/');
        Dictionary<string, Uri> routes = new(PluginRoutes.All.Count, StringComparer.Ordinal);
        foreach (var route in PluginRoutes.All)
            routes[route] = new Uri(prefix + route, UriKind.Absolute);
        return routes.ToFrozenDictionary(StringComparer.Ordinal);
    }

    private static PluginTransportException Refused(string name, string detail) =>
        new(PluginTransportCodes.Refused, $"{name}: {detail}");
}

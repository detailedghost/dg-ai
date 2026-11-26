using Dg.Core.Abstractions;
using Dg.Core.Plugins.Manifest;

namespace Dg.Core.Tests;

internal static class TestManifest
{
    public static PluginManifest Http(string endpoint, bool remote = false) =>
        new(
            Name: "scanner",
            Version: "1.0.0",
            Kind: PluginKind.Hook,
            Transport: PluginTransportKind.Http,
            Endpoint: endpoint,
            Remote: remote,
            Source: null,
            Pin: null,
            Entry: new(null, "scanner", []),
            Capabilities: new(false, [], [], []),
            Permissions: new([], [])
        );
}

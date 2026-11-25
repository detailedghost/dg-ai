using Dg.Core.Plugins.Manifest;

namespace Dg.Core.Transport.Tcp;

public interface ITcpManifestResolver
{
    PluginManifest Manifest(string plugin);
}

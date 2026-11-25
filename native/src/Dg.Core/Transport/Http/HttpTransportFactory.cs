using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;

namespace Dg.Core.Transport.Http;

public interface IHttpTransportFactory
{
    IPluginTransport Create(PluginManifest manifest, bool allowRemote);
}

public sealed class HttpTransportFactory(IPluginTokenProvider tokens) : IHttpTransportFactory
{
    public IPluginTransport Create(PluginManifest manifest, bool allowRemote) =>
        new HttpTransport(manifest, allowRemote, tokens);
}

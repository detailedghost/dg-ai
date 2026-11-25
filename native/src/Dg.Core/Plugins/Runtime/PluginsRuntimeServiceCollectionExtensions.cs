using Dg.Core.Config;
using Dg.Core.Credentials;
using Dg.Core.Paths;
using Dg.Core.Transport.Http;
using Dg.Core.Transport.Ipc;
using Dg.Core.Transport.Pool;
using Dg.Core.Transport.Tcp;
using Dg.Core.Transport.Udp;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Plugins.Runtime;

public static class PluginsRuntimeServiceCollectionExtensions
{
    public static IServiceCollection AddPluginsRuntime(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton(static sp => new PluginManifestStore(sp.GetRequiredService<DgPaths>()));
        services.AddSingleton<IIpcEndpointResolver>(static sp => new DataDirIpcEndpointResolver(sp.GetRequiredService<PluginManifestStore>()));
        services.AddSingleton<ITcpManifestResolver>(static sp => sp.GetRequiredService<PluginManifestStore>());
        services.AddSingleton<IPluginTokenProvider>(static sp => new CredentialPluginTokenProvider(sp.GetRequiredService<ICredentialStore>()));
        services.AddIpcTransport().AddTcpTransport().AddHttpTransport().AddUdpTransport();
        services.AddKeyedSingleton<IPluginTransportProvider>(
            PluginTransportKeys.Ipc,
            static (sp, _) => new PoolTransportProvider(sp.GetRequiredService<PluginConnectionPool>())
        );
        services.AddKeyedSingleton<IPluginTransportProvider>(
            PluginTransportKeys.Tcp,
            static (sp, _) => new PoolTransportProvider(sp.GetRequiredKeyedService<PluginConnectionPool>(TcpTransportKeys.Pool))
        );
        services.AddKeyedSingleton<IPluginTransportProvider>(
            PluginTransportKeys.Http,
            static (sp, _) => new HttpTransportProvider(sp.GetRequiredService<IHttpTransportFactory>())
        );
        services.AddSingleton<IPluginHost>(static sp => new PluginHost(
            sp.GetRequiredService<DgToml>(),
            sp.GetRequiredService<PluginManifestStore>(),
            sp.GetServices<IBuiltinPlugin>(),
            sp,
            sp.GetService<IPluginLatencyObserver>()
        ));
        return services;
    }
}

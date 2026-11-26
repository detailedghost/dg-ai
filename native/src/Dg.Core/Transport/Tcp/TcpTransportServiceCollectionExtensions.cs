using Dg.Core.Transport.Pool;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Transport.Tcp;

public static class TcpTransportKeys
{
    public const string Pool = "tcp";
}

public static class TcpTransportServiceCollectionExtensions
{
    public static IServiceCollection AddTcpTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton(static sp => new TcpConnector(
            sp.GetRequiredService<ITcpManifestResolver>(),
            sp.GetRequiredService<Http.IPluginTokenProvider>()
        ));
        services.AddKeyedSingleton(
            TcpTransportKeys.Pool,
            static (sp, _) => new PluginConnectionPool(sp.GetRequiredService<TcpConnector>().ConnectAsync)
        );
        return services;
    }
}

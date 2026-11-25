using Dg.Core.Transport.Pool;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Transport.Ipc;

public static class IpcServiceCollectionExtensions
{
    public static IServiceCollection AddIpcTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton(static sp => new IpcConnector(sp.GetRequiredService<IIpcEndpointResolver>()));
        services.AddSingleton(static sp => new PluginConnectionPool(sp.GetRequiredService<IpcConnector>().ConnectAsync));
        return services;
    }
}

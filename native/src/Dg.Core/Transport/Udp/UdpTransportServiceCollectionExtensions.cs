using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Transport.Udp;

public delegate IEventSink UdpSinkFactory(PluginManifest manifest);

public static class UdpTransportServiceCollectionExtensions
{
    public static IServiceCollection AddUdpTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        return services.AddSingleton<UdpSinkFactory>(static manifest =>
            new UdpTransport(UdpEventGuard.Resolve(manifest))
        );
    }
}

using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Transport.Http;

public static class HttpTransportServiceCollectionExtensions
{
    public static IServiceCollection AddHttpTransport(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        return services.AddSingleton<IHttpTransportFactory, HttpTransportFactory>();
    }
}

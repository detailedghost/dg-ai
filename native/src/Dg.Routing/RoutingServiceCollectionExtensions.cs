using Dg.Core.Abstractions;
using Dg.Core.Output;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Routing;

public static class RoutingServiceCollectionExtensions
{
    public static IServiceCollection AddRouting(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<ICommand>(static _ => new VersionCommand(VersionCommand.Current(), OutputWriter.Out));
        services.AddSingleton(static _ => new CoreLauncher(CoreLauncher.DefaultPath()));
        services.AddSingleton(static sp => new Route(sp.GetServices<ICommand>()));
        return services;
    }
}

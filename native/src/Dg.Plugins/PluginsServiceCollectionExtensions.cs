using Dg.Core.Abstractions;
using Dg.Core.Output;
using Dg.Core.Paths;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Plugins;

/// <summary>Registers plugin list and verify. The root runs the other plugin commands in dg-core.</summary>
public static class PluginsServiceCollectionExtensions
{
    public static IServiceCollection AddPlugins(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<ICommand>(static _ => new PluginListCommand(
            ProcessEnvironment.Capture(),
            OutputWriter.Out,
            OutputWriter.Err
        ));
        services.AddSingleton<ICommand>(static _ => new PluginVerifyCommand(
            ProcessEnvironment.Capture(),
            OutputWriter.Out,
            OutputWriter.Err
        ));
        return services;
    }
}

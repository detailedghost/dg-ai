using System.Collections;
using Dg.Core.Abstractions;
using Dg.Core.Output;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Plugins;

/// <summary>Registers dg plugin list and verify. add, remove, update, enable and disable are not registered, so the root runs them in dg-core.</summary>
public static class PluginsServiceCollectionExtensions
{
    public static IServiceCollection AddPlugins(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<ICommand>(static _ => new PluginListCommand(Capture(), OutputWriter.Out, OutputWriter.Err));
        services.AddSingleton<ICommand>(static _ => new PluginVerifyCommand(Capture(), OutputWriter.Out, OutputWriter.Err));
        return services;
    }

    private static Dictionary<string, string?> Capture()
    {
        var env = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            env[(string)entry.Key] = entry.Value as string;
        return env;
    }
}

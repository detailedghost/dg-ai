using System.Collections;
using Dg.Core.Abstractions;
using Dg.Core.Output;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Config;

public static class ConfigServiceCollectionExtensions
{
    public static IServiceCollection AddConfig(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<ICommand>(static _ => new ConfigGetCommand(Capture(), OutputWriter.Out, OutputWriter.Err));
        services.AddSingleton<ICommand>(static _ => new ConfigSetCommand(Capture(), OutputWriter.Out, OutputWriter.Err));
        services.AddSingleton<ICommand>(static _ => new ConfigListCommand(Capture(), OutputWriter.Out, OutputWriter.Err));
        services.AddSingleton<ICommand>(static _ => new ConfigDoctorCommand(Capture(), OutputWriter.Out, OutputWriter.Err));
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

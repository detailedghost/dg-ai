using Dg.Core.Abstractions;
using Dg.Core.Output;
using Dg.Core.Paths;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Config;

public static class ConfigServiceCollectionExtensions
{
    public static IServiceCollection AddConfig(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<ICommand>(static _ => new ConfigGetCommand(ProcessEnvironment.Capture(), OutputWriter.Out, OutputWriter.Err));
        services.AddSingleton<ICommand>(static _ => new ConfigSetCommand(ProcessEnvironment.Capture(), OutputWriter.Out, OutputWriter.Err));
        services.AddSingleton<ICommand>(static _ => new ConfigListCommand(ProcessEnvironment.Capture(), OutputWriter.Out, OutputWriter.Err));
        services.AddSingleton<ICommand>(static _ => new ConfigDoctorCommand(ProcessEnvironment.Capture(), OutputWriter.Out, OutputWriter.Err));
        return services;
    }
}

using Dg.Hooks.Engine;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks.Defs.Repo;

internal static partial class RepoHooksRegistration
{
    static partial void Register(IServiceCollection services)
    {
        services.AddSingleton<ICommandRunner, ProcessCommandRunner>();
        services.AddSingleton<IDetachedSpawner, ProcessDetachedSpawner>();
        services.AddSingleton<IHook>(provider => new SpecPlanLintHook(
            provider.GetRequiredService<ICommandRunner>(),
            Console.Error
        ));
        services.AddSingleton<IHook>(provider => new DailyPruneHook(
            Environment.GetEnvironmentVariable,
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            provider.GetRequiredService<ICommandRunner>(),
            provider.GetRequiredService<IDetachedSpawner>(),
            TimeProvider.System,
            Console.Out,
            Console.Error
        ));
    }
}

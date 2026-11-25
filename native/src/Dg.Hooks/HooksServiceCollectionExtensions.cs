using Dg.Hooks.Defs.Pr;
using Dg.Hooks.Defs.Repo;
using Dg.Hooks.Defs.Text;
using Dg.Hooks.Engine;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks;

public static class HooksServiceCollectionExtensions
{
    public static IServiceCollection AddHooks(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton(provider => new HookEngine(
            provider.GetServices<IHook>(),
            Console.Error
        ));
        return services.AddPrHooks().AddTextHooks().AddRepoHooks();
    }
}

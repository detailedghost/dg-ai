using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks.Defs.Repo;

internal static partial class RepoHooksRegistration
{
    public static IServiceCollection AddRepoHooks(this IServiceCollection services)
    {
        Register(services);
        return services;
    }

    static partial void Register(IServiceCollection services);
}

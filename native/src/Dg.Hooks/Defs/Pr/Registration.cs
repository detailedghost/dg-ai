using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks.Defs.Pr;

internal static partial class PrHooksRegistration
{
    public static IServiceCollection AddPrHooks(this IServiceCollection services)
    {
        Register(services);
        return services;
    }

    static partial void Register(IServiceCollection services);
}

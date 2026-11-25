using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks.Defs.Text;

internal static partial class TextHooksRegistration
{
    public static IServiceCollection AddTextHooks(this IServiceCollection services)
    {
        Register(services);
        return services;
    }

    static partial void Register(IServiceCollection services);
}

using Dg.Hooks.Engine;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks.Defs.Pr;

internal static partial class PrHooksRegistration
{
    static partial void Register(IServiceCollection services)
    {
        var host = new PrHookHost();
        services.AddSingleton<IHook>(_ => new PrConfirmHook(host));
        services.AddSingleton<IHook>(_ => new PrProseHook(host));
        services.AddSingleton<IHook>(_ => new StripAiCoauthorsHook(host));
    }
}

using Dg.Hooks.Engine;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks.Defs.Text;

internal static partial class TextHooksRegistration
{
    static partial void Register(IServiceCollection services)
    {
        services.AddSingleton<IHook>(_ => new SpellingHook());
        services.AddSingleton<IHook>(_ => new FormatHook());
    }
}

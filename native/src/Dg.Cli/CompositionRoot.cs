using Dg.Completion;
using Dg.Config;
using Dg.Core.Abstractions;
using Dg.Hooks;
using Dg.Hooks.Engine;
using Dg.Plugins;
using Dg.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Cli;

internal static class CompositionRoot
{
    public static ServiceProvider Build()
    {
        var services = new ServiceCollection();
        services.AddSingleton<ICommand>(static _ => new CompleteGateCommand(new CompleteCommand()));
        services.AddSingleton<ICommand>(static sp => new HooksRunCommand(
            sp.GetRequiredService<HookEngine>,
            sp.GetServices<IHook>
        ));
        services.AddHooks().AddConfig().AddRouting().AddPlugins();
        return services.BuildServiceProvider();
    }
}

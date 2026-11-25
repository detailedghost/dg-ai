using Dg.Completion;
using Dg.Config;
using Dg.Core.Abstractions;
using Dg.Core.Config;
using Dg.Core.Credentials;
using Dg.Core.Paths;
using Dg.Core.Plugins.Runtime;
using Dg.Hooks;
using Dg.Hooks.Engine;
using Dg.Plugins;
using Dg.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Cli;

internal static class CompositionRoot
{
    public static ServiceProvider Build(IReadOnlyDictionary<string, string?> env, DgToml? toml)
    {
        var services = new ServiceCollection();
        services.AddSingleton(_ => DgPaths.Resolve(DgPathSeams.Current(env)).GetOrThrow());
        services.AddSingleton(_ => toml ?? DgConfig.Load(env).GetOrThrow());
        services.AddSingleton<ICredentialStore>(static _ => new UnavailableCredentialStore());
        services.AddSingleton<ICommand>(static _ => new CompleteGateCommand(new CompleteCommand()));
        services.AddSingleton<ICommand>(static sp => new HooksRunCommand(
            sp.GetRequiredService<HookEngine>,
            sp.GetServices<IHook>
        ));
        services.AddHooks().AddConfig().AddRouting().AddPlugins().AddPluginsRuntime();
        return services.BuildServiceProvider(new ServiceProviderOptions { ValidateOnBuild = false });
    }
}

using Dg.Core.Abstractions;
using Dg.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Cli;

internal static class FrontDoor
{
    public static async ValueTask<int> RunAsync(string[] args, CancellationToken ct)
    {
        var env = EnvSnapshot.Capture();
        var choice = FrontGate.Decide(env);
        if (!choice.Native)
            return new CoreLauncher(CoreLauncher.DefaultPath()).Launch(args);

        using var provider = CompositionRoot.Build(env, choice.Toml);
        var launcher = provider.GetRequiredService<CoreLauncher>();
        if (provider.GetRequiredService<Route>().Resolve(args) is not Route.Native native)
            return launcher.Launch(args);

        var exit = await native.Command.RunAsync(native.Args, ct);
        return exit == CliExit.NotNative ? launcher.Launch(args) : exit;
    }
}

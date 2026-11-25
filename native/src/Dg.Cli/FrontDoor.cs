using Dg.Core.Abstractions;
using Dg.Core.Paths;
using Dg.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Cli;

internal static class FrontDoor
{
    public static async ValueTask<int> RunAsync(string[] args, CancellationToken ct)
    {
        if (!FrontGate.IsNative(ProcessEnvironment.Capture()))
            return new CoreLauncher(CoreLauncher.DefaultPath()).Launch(args);

        using var provider = CompositionRoot.Build();
        var launcher = provider.GetRequiredService<CoreLauncher>();
        if (provider.GetRequiredService<Route>().Resolve(args) is not Route.Native native)
            return launcher.Launch(args);

        var exit = await native.Command.RunAsync(native.Args, ct);
        return exit == ExitCodes.NotNative ? launcher.Launch(args) : exit;
    }
}

using Dg.Core.Abstractions;
using Dg.Core.Errors;
using Dg.Core.Output;
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

        var exit = await RunNativeAsync(native.Command, native.Args, ct);
        return exit == ExitCodes.NotNative ? launcher.Launch(args) : exit;
    }

    internal static async ValueTask<int> RunNativeAsync(ICommand command, ReadOnlyMemory<string> args, CancellationToken ct)
    {
        try
        {
            return await command.RunAsync(args, ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or DgException)
        {
            OutputWriter.Err.WriteLine($"dg: {ex.Message}");
            OutputWriter.Err.Flush();
            return 1;
        }
    }
}

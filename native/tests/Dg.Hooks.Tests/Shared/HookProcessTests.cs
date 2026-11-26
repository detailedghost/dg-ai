using Dg.Hooks.Shared;

namespace Dg.Hooks.Tests;

public sealed class HookProcessTests
{
    [Fact]
    public async Task RunAsync_GrandchildHoldsPipe_ReturnsAfterBoundedDrain()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "needs a POSIX shell");

        var started = TimeProvider.System.GetTimestamp();
        var result = await HookProcess.RunAsync(
            HookEnvironment.Process().Values,
            ["sh", "-c", "sleep 20 & echo done"],
            null,
            CancellationToken.None
        );

        Assert.Equal(0, result.Status);
        Assert.Equal("done\n", result.Stdout);
        Assert.True(TimeProvider.System.GetElapsedTime(started) < TimeSpan.FromMilliseconds(HookProcess.DrainMs) + TimeSpan.FromSeconds(10));
    }
}

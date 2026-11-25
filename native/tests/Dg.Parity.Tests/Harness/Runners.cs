namespace Dg.Parity.Tests.Harness;

internal static class Runners
{
    public static async Task<Observed> BunAsync(ParityCase entry)
    {
        var host = FrontDoorHost.Shared;
        using var sandbox = new Sandbox();
        sandbox.Materialize(entry);
        var run = await Proc.RunAsync(
            host.Bun,
            [host.BunIndex, .. entry.Argv.Select(sandbox.Substitute)],
            sandbox.Env(entry, host, "bun"),
            sandbox.WorkingDirectory(entry),
            sandbox.Substitute(entry.Stdin ?? "")
        );
        return sandbox.Observe(run);
    }

    public static async Task<Observed> FrontAsync(ParityCase entry)
    {
        var host = FrontDoorHost.Shared;
        using var sandbox = new Sandbox();
        sandbox.Materialize(entry);
        var run = await Proc.RunAsync(
            host.WithCore,
            entry.Argv.Select(sandbox.Substitute),
            sandbox.Env(entry, host, "bun"),
            sandbox.WorkingDirectory(entry),
            sandbox.Substitute(entry.Stdin ?? "")
        );
        return sandbox.Observe(run);
    }

    public static async Task AssertSameAsBunAsync(ParityCase entry)
    {
        var bun = await BunAsync(entry);
        var front = await FrontAsync(entry);

        Assert.Equal(bun.Stdout, front.Stdout);
        Assert.Equal(bun.Stderr, front.Stderr);
        Assert.Equal(bun.Exit, front.Exit);
        Assert.Equal(bun.Config, front.Config);
        Assert.Equal(bun.After, front.After);
    }
}

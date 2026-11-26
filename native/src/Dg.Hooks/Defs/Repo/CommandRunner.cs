using Dg.Hooks.Shared;

namespace Dg.Hooks.Defs.Repo;

internal interface ICommandRunner
{
    ValueTask<CommandResult> RunAsync(IReadOnlyList<string> argv, string? cwd, CancellationToken ct);
}

internal sealed class ProcessCommandRunner : ICommandRunner
{
    public async ValueTask<CommandResult> RunAsync(
        IReadOnlyList<string> argv,
        string? cwd,
        CancellationToken ct
    )
    {
        ArgumentNullException.ThrowIfNull(argv);
        return await HookProcess.RunAsync(HookEnvironment.Process().Values, [.. argv], cwd, ct);
    }
}

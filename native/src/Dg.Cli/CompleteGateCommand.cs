using Dg.Core.Abstractions;

namespace Dg.Cli;

internal sealed class CompleteGateCommand(ICommand complete) : ICommand
{
    private const int MinimumWords = 2;

    public string Name => complete.Name;

    public ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct) =>
        args.Length < MinimumWords ? ValueTask.FromResult(ExitCodes.NotNative) : complete.RunAsync(args, ct);
}

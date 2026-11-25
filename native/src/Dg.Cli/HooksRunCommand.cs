using Dg.Core.Abstractions;
using Dg.Hooks.Engine;

namespace Dg.Cli;

internal sealed class HooksRunCommand(Func<HookEngine> engine, Func<IEnumerable<IHook>> hooks) : ICommand
{
    public string Name => "hooks run";

    public async ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct)
    {
        if (args.IsEmpty || !IsBuiltIn(args.Span[0]))
            return ExitCodes.NotNative;

        await using var stdin = Console.OpenStandardInput();
        return await engine().RunAsync(args.Span[0], args.Span[1..].ToArray(), stdin, ct);
    }

    private bool IsBuiltIn(string id)
    {
        foreach (var hook in hooks())
            if (hook.Id == id)
                return true;
        return false;
    }
}

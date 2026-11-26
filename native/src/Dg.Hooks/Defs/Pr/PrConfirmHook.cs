using Dg.Hooks.Engine;

namespace Dg.Hooks.Defs.Pr;

internal sealed class PrConfirmHook(PrHookHost host) : IHook
{
    private const string Ask =
        """{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Always confirm with the user before opening a PR"}}""";

    public string Id => "pr-confirm";

    public ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
    {
        if (PrCommandParser.InvokesPr(ev.Command ?? "", PrAction.Create))
            host.Output.Write(Ask);
        return ValueTask.FromResult(0);
    }
}

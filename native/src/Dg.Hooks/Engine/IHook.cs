namespace Dg.Hooks.Engine;

public interface IHook
{
    string Id { get; }

    bool UsesStdin(string[] args) => true;

    ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct);
}

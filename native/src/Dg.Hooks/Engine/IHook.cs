namespace Dg.Hooks.Engine;

public interface IHook
{
    string Id { get; }

    ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct);
}

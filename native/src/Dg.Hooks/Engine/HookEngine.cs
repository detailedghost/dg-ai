using System.Collections.Frozen;

namespace Dg.Hooks.Engine;

public sealed class HookEngine
{
    private readonly FrozenDictionary<string, IHook> _hooks;
    private readonly TextWriter _error;

    public HookEngine(IEnumerable<IHook> hooks, TextWriter error)
    {
        ArgumentNullException.ThrowIfNull(hooks);
        ArgumentNullException.ThrowIfNull(error);
        _hooks = hooks.ToFrozenDictionary(hook => hook.Id, StringComparer.Ordinal);
        _error = error;
    }

    public async ValueTask<int> RunAsync(
        string id,
        string[] args,
        Stream? stdin,
        CancellationToken ct
    )
    {
        ArgumentNullException.ThrowIfNull(id);
        ArgumentNullException.ThrowIfNull(args);
        if (!_hooks.TryGetValue(id, out var hook))
            return 0;

        var ev = HookEvent.Parse(await ReadAllAsync(stdin, ct)) with { Args = args };
        var worst = 0;
        try
        {
            foreach (var input in ApplyPatch.Expand(ev))
            {
                var code = await hook.RunAsync(input, ct);
                if (worst != 2 && code > worst)
                    worst = code;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await _error.WriteAsync($"hooks run {id}: {ex.Message}\n");
            return 1;
        }
        return worst;
    }

    private static async ValueTask<byte[]> ReadAllAsync(Stream? stdin, CancellationToken ct)
    {
        if (stdin is null)
            return [];
        using var buffer = new MemoryStream();
        await stdin.CopyToAsync(buffer, ct);
        return buffer.ToArray();
    }
}

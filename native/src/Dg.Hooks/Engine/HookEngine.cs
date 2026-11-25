using System.Collections.Frozen;
using Dg.Hooks.Shared;

namespace Dg.Hooks.Engine;

public sealed class HookEngine
{
    private readonly FrozenDictionary<string, IHook> _hooks;
    private readonly TextWriter _error;
    private readonly TextWriter? _output;
    private readonly HookDirectories? _directories;
    private readonly Func<bool> _stdinIsTerminal;

    public HookEngine(
        IEnumerable<IHook> hooks,
        TextWriter error,
        TextWriter? output = null,
        HookDirectories? directories = null,
        Func<bool>? stdinIsTerminal = null
    )
    {
        ArgumentNullException.ThrowIfNull(hooks);
        ArgumentNullException.ThrowIfNull(error);
        _hooks = hooks.ToFrozenDictionary(hook => hook.Id, StringComparer.Ordinal);
        _error = error;
        _output = output;
        _directories = directories;
        _stdinIsTerminal = stdinIsTerminal ?? (() => false);
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

        var usesStdin = hook.UsesStdin(args);
        var sink = new ContextSink();
        var ev =
            HookEvent.Parse(await ReadAllAsync(usesStdin && !_stdinIsTerminal() ? stdin : null, ct))
            with
            {
                Args = args,
                Sink = sink,
            };
        var worst = 0;
        try
        {
            if (usesStdin)
                _directories?.Verify();
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
        if (!sink.IsEmpty)
            await (_output ?? Console.Out).WriteAsync(HookJson.AdditionalContext(sink.EventName!, sink.Joined));
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

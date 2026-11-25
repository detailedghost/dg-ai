using System.Collections.Concurrent;

namespace Dg.Core.Transport.Pool;

public sealed class PluginConnectionPool(Func<string, CancellationToken, ValueTask<Stream>> connect) : IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, PluginConnection> _warm = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _gate = new(1, 1);

    public ValueTask<PluginConnection> GetAsync(string plugin, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(plugin);
        return _warm.TryGetValue(plugin, out var warm) && warm.IsUsable
            ? ValueTask.FromResult(warm)
            : ConnectAsync(plugin, ct);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var (_, connection) in _warm)
            await connection.DisposeAsync().ConfigureAwait(false);
        _warm.Clear();
        _gate.Dispose();
    }

    private async ValueTask<PluginConnection> ConnectAsync(string plugin, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_warm.TryGetValue(plugin, out var existing))
            {
                if (existing.IsUsable)
                    return existing;
                await existing.DisposeAsync().ConfigureAwait(false);
            }
            var created = new PluginConnection(await connect(plugin, ct).ConfigureAwait(false));
            _warm[plugin] = created;
            return created;
        }
        finally
        {
            _gate.Release();
        }
    }
}

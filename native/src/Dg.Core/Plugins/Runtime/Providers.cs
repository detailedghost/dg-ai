using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Http;
using Dg.Core.Transport.Ipc;
using Dg.Core.Transport.Pool;
using Dg.Core.Credentials;

namespace Dg.Core.Plugins.Runtime;

public interface IPluginTransportProvider
{
    ValueTask<TransportLease> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct);
}

internal interface ITransportLeaseOwner
{
    ValueTask ReleaseAsync();
}

public readonly struct TransportLease : IAsyncDisposable
{
    private readonly ITransportLeaseOwner? _owner;

    internal TransportLease(IPluginTransport transport, ITransportLeaseOwner? owner)
    {
        Transport = transport;
        _owner = owner;
    }

    public IPluginTransport Transport { get; }

    public ValueTask DisposeAsync() => _owner?.ReleaseAsync() ?? ValueTask.CompletedTask;
}

public static class PluginTransportKeys
{
    public const string Ipc = "ipc";
    public const string Tcp = "tcp";
    public const string Http = "http";

    public static string For(PluginManifest manifest) =>
        manifest.Transport switch
        {
            PluginTransportKind.Ipc => Ipc,
            PluginTransportKind.Tcp => Tcp,
            PluginTransportKind.Http => Http,
            _ => throw new PluginContractException(
                PluginRuntimeCodes.EventsOnly,
                $"dg plugin: {manifest.Name}: udp carries events only. Next: use the ipc, tcp or http transport for request and reply plugins."
            ),
        };
}

public sealed class PoolTransportProvider(PluginConnectionPool pool) : IPluginTransportProvider
{
    public async ValueTask<TransportLease> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct) =>
        new(await pool.GetAsync(manifest.Name, ct).ConfigureAwait(false), null);
}

public sealed class HttpTransportProvider(IHttpTransportFactory factory) : IPluginTransportProvider, IAsyncDisposable
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Entry> _open = new(StringComparer.Ordinal);
    private readonly HashSet<Entry> _retired = [];
    private bool _disposed;

    public ValueTask<TransportLease> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct)
    {
        var identity = $"{manifest.Endpoint}|{manifest.Remote}|{allowRemote}";
        Entry? toDispose = null;
        TransportLease lease;
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (!_open.TryGetValue(manifest.Name, out var entry) || entry.Identity != identity)
            {
                var created = new Entry(this, identity, factory.Create(manifest, allowRemote));
                if (entry is not null)
                    toDispose = Retire(entry);
                _open[manifest.Name] = entry = created;
            }
            entry.Leases++;
            lease = new TransportLease(entry.Transport, entry);
        }
        return toDispose is null ? ValueTask.FromResult(lease) : DisposeThenAsync(toDispose, lease);
    }

    public async ValueTask DisposeAsync()
    {
        Entry[] all;
        lock (_gate)
        {
            _disposed = true;
            all = [.. _retired, .. _open.Values];
            _retired.Clear();
            _open.Clear();
            foreach (var entry in all)
                entry.Closed = true;
        }
        List<Exception> failures = [];
        foreach (var entry in all)
        {
            try
            {
                await entry.Transport.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                failures.Add(ex);
            }
        }
        if (failures.Count > 0)
            throw new AggregateException(failures);
    }

    private Entry? Retire(Entry entry)
    {
        if (entry.Leases > 0)
        {
            _retired.Add(entry);
            return null;
        }
        entry.Closed = true;
        return entry;
    }

    private static async ValueTask<TransportLease> DisposeThenAsync(Entry retired, TransportLease lease)
    {
        await DisposeQuietlyAsync(retired).ConfigureAwait(false);
        return lease;
    }

    private static async ValueTask DisposeQuietlyAsync(Entry entry)
    {
        try
        {
            await entry.Transport.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception) { }
    }

    private ValueTask Release(Entry entry)
    {
        lock (_gate)
        {
            entry.Leases--;
            if (entry.Closed || entry.Leases > 0 || !_retired.Remove(entry))
                return ValueTask.CompletedTask;
            entry.Closed = true;
        }
        return DisposeQuietlyAsync(entry);
    }

    private sealed class Entry(HttpTransportProvider owner, string identity, IPluginTransport transport) : ITransportLeaseOwner
    {
        public string Identity { get; } = identity;

        public IPluginTransport Transport { get; } = transport;

        public int Leases;

        public bool Closed;

        public ValueTask ReleaseAsync() => owner.Release(this);
    }
}

public sealed class DataDirIpcEndpointResolver(PluginManifestStore store) : IIpcEndpointResolver
{
    public string SocketPath(string plugin)
    {
        if (OperatingSystem.IsWindows())
            return $@"\\.\pipe\dg-plugin-{plugin}";
        var endpoint = store.Manifest(plugin).Endpoint;
        if (endpoint is null)
            throw new PluginContractException(
                "manifest",
                $"dg plugin: {plugin}: the ipc transport needs an endpoint. Next: set endpoint in plugin.toml."
            );
        if (!IpcEndpoint.IsBareFileName(endpoint))
            throw new PluginContractException(
                "manifest",
                $"dg plugin: {plugin}: the ipc endpoint must be a plain file name inside the plugin folder. Next: fix endpoint in plugin.toml."
            );
        return Path.Combine(store.Folder(plugin), endpoint);
    }
}

public sealed class CredentialPluginTokenProvider(ICredentialStore store) : IPluginTokenProvider
{
    public ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct) =>
        store.GetAsync(credentialName, ct);
}

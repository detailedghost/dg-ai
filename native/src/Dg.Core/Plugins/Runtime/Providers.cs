using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Http;
using Dg.Core.Transport.Ipc;
using Dg.Core.Transport.Pool;
using Dg.Core.Credentials;

namespace Dg.Core.Plugins.Runtime;

public interface IPluginTransportProvider
{
    ValueTask<IPluginTransport> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct);
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
    public async ValueTask<IPluginTransport> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct) =>
        await pool.GetAsync(manifest.Name, ct).ConfigureAwait(false);
}

public sealed class HttpTransportProvider(IHttpTransportFactory factory) : IPluginTransportProvider, IAsyncDisposable
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, OpenTransport> _open = new(StringComparer.Ordinal);
    private readonly List<IPluginTransport> _retired = [];

    public ValueTask<IPluginTransport> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct)
    {
        var identity = $"{manifest.Endpoint}|{manifest.Remote}|{allowRemote}";
        lock (_gate)
        {
            if (_open.TryGetValue(manifest.Name, out var existing))
            {
                if (existing.Identity == identity)
                    return ValueTask.FromResult(existing.Transport);
                _retired.Add(existing.Transport);
            }
            var current = factory.Create(manifest, allowRemote);
            _open[manifest.Name] = new OpenTransport(identity, current);
            return ValueTask.FromResult(current);
        }
    }

    public async ValueTask DisposeAsync()
    {
        IPluginTransport[] all;
        lock (_gate)
        {
            all = [.. _retired, .. _open.Values.Select(static entry => entry.Transport)];
            _retired.Clear();
            _open.Clear();
        }
        List<Exception> failures = [];
        foreach (var transport in all)
        {
            try
            {
                await transport.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                failures.Add(ex);
            }
        }
        if (failures.Count > 0)
            throw new AggregateException(failures);
    }

    private sealed record OpenTransport(string Identity, IPluginTransport Transport);
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

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

    public async ValueTask<IPluginTransport> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct)
    {
        var identity = $"{manifest.Endpoint}|{manifest.Remote}|{allowRemote}";
        IPluginTransport? replaced = null;
        IPluginTransport current;
        lock (_gate)
        {
            if (_open.TryGetValue(manifest.Name, out var existing))
            {
                if (existing.Identity == identity)
                    return existing.Transport;
                replaced = existing.Transport;
            }
            current = factory.Create(manifest, allowRemote);
            _open[manifest.Name] = new OpenTransport(identity, current);
        }
        if (replaced is not null)
            await replaced.DisposeAsync().ConfigureAwait(false);
        return current;
    }

    public async ValueTask DisposeAsync()
    {
        OpenTransport[] open;
        lock (_gate)
        {
            open = [.. _open.Values];
            _open.Clear();
        }
        foreach (var entry in open)
            await entry.Transport.DisposeAsync().ConfigureAwait(false);
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

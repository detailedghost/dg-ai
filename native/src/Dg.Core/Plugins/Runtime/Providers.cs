using System.Collections.Concurrent;
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
    private readonly ConcurrentDictionary<string, Lazy<IPluginTransport>> _open = new(StringComparer.Ordinal);

    public ValueTask<IPluginTransport> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct) =>
        ValueTask.FromResult(
            _open
                .GetOrAdd(
                    $"{manifest.Name}|{manifest.Endpoint}|{allowRemote}",
                    _ => new Lazy<IPluginTransport>(() => factory.Create(manifest, allowRemote))
                )
                .Value
        );

    public async ValueTask DisposeAsync()
    {
        foreach (var (_, transport) in _open)
            if (transport.IsValueCreated)
                await transport.Value.DisposeAsync().ConfigureAwait(false);
        _open.Clear();
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

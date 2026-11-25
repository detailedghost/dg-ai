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
}

public sealed class PoolTransportProvider(PluginConnectionPool pool) : IPluginTransportProvider
{
    public async ValueTask<IPluginTransport> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct) =>
        await pool.GetAsync(manifest.Name, ct).ConfigureAwait(false);
}

public sealed class HttpTransportProvider(IHttpTransportFactory factory) : IPluginTransportProvider, IAsyncDisposable
{
    private readonly ConcurrentDictionary<string, IPluginTransport> _open = new(StringComparer.Ordinal);

    public ValueTask<IPluginTransport> OpenAsync(PluginManifest manifest, bool allowRemote, CancellationToken ct) =>
        ValueTask.FromResult(_open.GetOrAdd(manifest.Name, _ => factory.Create(manifest, allowRemote)));

    public async ValueTask DisposeAsync()
    {
        foreach (var (_, transport) in _open)
            await transport.DisposeAsync().ConfigureAwait(false);
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
        return endpoint is null
            ? throw new PluginContractException(
                "manifest",
                $"dg plugin: {plugin}: the ipc transport needs an endpoint. Next: set endpoint in plugin.toml."
            )
            : Path.Combine(store.Folder(plugin), endpoint);
    }
}

public sealed class CredentialPluginTokenProvider(ICredentialStore store) : IPluginTokenProvider
{
    public ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct) =>
        store.GetAsync(credentialName, ct);
}

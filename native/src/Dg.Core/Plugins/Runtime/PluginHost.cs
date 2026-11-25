using System.Diagnostics;
using System.Text.Json;
using Dg.Core.Config;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Plugins.Runtime;

public sealed class PluginHost(
    DgToml config,
    PluginManifestStore store,
    IEnumerable<IBuiltinPlugin> builtins,
    IServiceProvider services,
    IPluginLatencyObserver? observer = null
) : IPluginHost
{
    private static readonly JsonElement EmptyBody = JsonDocument.Parse("{}").RootElement.Clone();
    private int _lastId;

    public async ValueTask<PluginResponse> InvokeAsync(string name, PluginEnvelope message, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(name);
        ArgumentNullException.ThrowIfNull(message);
        MessageValidator.Validate(message.Route, MessageDirection.Request, message.Body);
        foreach (var builtin in builtins)
            if (string.Equals(builtin.Name, name, StringComparison.Ordinal))
            {
                if (config.Plugins.TryGetValue(name, out var configured) && !configured.Enabled)
                    throw Disabled(name);
                return await builtin.HandleAsync(message, ct).ConfigureAwait(false);
            }

        var manifest = Admit(name, out var allowRemote);
        var key = PluginTransportKeys.For(manifest);
        var provider = services.GetRequiredKeyedService<IPluginTransportProvider>(key);
        var transport = await provider.OpenAsync(manifest, allowRemote, ct).ConfigureAwait(false);
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, PluginJsonContext.Default.PluginEnvelope);
        var frame = FrameCodec.Encode(FrameEncoding.Json, FrameFlags.None, NextId(), payload);

        var timeout = PluginRoutes.TimeoutFor(message.Route);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
        limit.CancelAfter(timeout);
        var started = Stopwatch.GetTimestamp();
        try
        {
            var response = await transport.SendAsync(frame, limit.Token).ConfigureAwait(false);
            Observe(manifest.Name, message.Route, manifest.Transport, Stopwatch.GetElapsedTime(started));
            return response;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new PluginTransportException(
                PluginTransportCodes.Timeout,
                $"{name}: {message.Route} took over {(int)timeout.TotalMilliseconds} ms. Next: check the plugin is healthy, then retry."
            );
        }
    }

    public async ValueTask<HealthResponse> HealthAsync(string name, CancellationToken ct)
    {
        var response = await InvokeAsync(name, new PluginEnvelope(PluginRoutes.Health, EmptyBody), ct).ConfigureAwait(false);
        if (response.Header.Encoding != FrameEncoding.Json)
            throw BadReply(name);
        try
        {
            using var document = JsonDocument.Parse(response.Payload);
            MessageValidator.Validate(PluginRoutes.Health, MessageDirection.Response, document.RootElement);
            return document.RootElement.Deserialize(PluginJsonContext.Default.HealthResponse) ?? throw BadReply(name);
        }
        catch (Exception ex) when (ex is JsonException or PluginContractException { Code: not PluginRuntimeCodes.BadReply })
        {
            throw BadReply(name);
        }
    }

    private PluginManifest Admit(string name, out bool allowRemote)
    {
        var folder = store.Folder(name);
        config.Plugins.TryGetValue(name, out var entry);
        if (entry is not { Enabled: true })
            throw Disabled(name);
        var manifest = store.Manifest(name);
        if (!string.Equals(manifest.Name, name, StringComparison.Ordinal))
            throw new PluginContractException(
                "manifest",
                $"dg plugin: {name}: plugin.toml names {manifest.Name}. Next: fix name in plugin.toml."
            );
        if (!PluginApproval.IsApproved(folder))
            throw new PluginContractException(
                PluginRuntimeCodes.Unapproved,
                $"dg plugin: {name} is not approved. Next: review it, then run dg plugin verify {name} --approve."
            );
        if (manifest.Entry.IsBuiltin)
            throw new PluginContractException(
                PluginRuntimeCodes.NotInstalled,
                $"dg plugin: {name}: built-in {manifest.Entry.Builtin} is not part of this build. Next: update dg."
            );
        allowRemote = manifest.Remote && entry.AllowRemote;
        if (manifest.Remote && !allowRemote)
            throw new PluginContractException(
                "remote-refused",
                $"dg plugin: {name} is remote but plugins.{name}.allow_remote is not true. Next: run dg config set plugins.{name}.allow_remote true if you trust {manifest.Endpoint}."
            );
        return manifest;
    }

    private uint NextId()
    {
        while (true)
        {
            var id = (uint)Interlocked.Increment(ref _lastId);
            if (id != 0)
                return id;
        }
    }

    private void Observe(string plugin, string route, PluginTransportKind kind, TimeSpan elapsed)
    {
        if (observer is null || route != PluginRoutes.HookDecide)
            return;
        var (ipc, tcp, http) = PluginRoutes.HookLatencyBudgetP99Ms;
        var budget = kind switch
        {
            PluginTransportKind.Ipc => ipc,
            PluginTransportKind.Tcp => tcp,
            _ => http,
        };
        if (elapsed.TotalMilliseconds > budget)
            observer.OverBudget(plugin, route, kind, elapsed, budget);
    }

    private static PluginContractException Disabled(string name) =>
        new(PluginRuntimeCodes.Disabled, $"dg plugin: {name} is disabled. Next: run dg plugin enable {name}.");

    private static PluginContractException BadReply(string name) =>
        new(PluginRuntimeCodes.BadReply, $"dg plugin: {name}: the health reply is not valid. Next: fix the plugin.");
}

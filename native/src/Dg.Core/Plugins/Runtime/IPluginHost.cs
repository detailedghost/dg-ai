using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;

namespace Dg.Core.Plugins.Runtime;

public interface IPluginHost
{
    ValueTask<PluginResponse> InvokeAsync(string name, PluginEnvelope message, CancellationToken ct);

    ValueTask<HealthResponse> HealthAsync(string name, CancellationToken ct);
}

public interface IBuiltinPlugin
{
    string Name { get; }

    ValueTask<PluginResponse> HandleAsync(PluginEnvelope message, CancellationToken ct);
}

public interface IPluginLatencyObserver
{
    void OverBudget(string plugin, string route, PluginTransportKind transport, TimeSpan elapsed, int budgetMs);
}

namespace Dg.Core.Plugins.Contract;

public interface IPluginTransport : IAsyncDisposable
{
    ValueTask<PluginResponse> SendAsync(ReadOnlyMemory<byte> frame, CancellationToken ct);
}

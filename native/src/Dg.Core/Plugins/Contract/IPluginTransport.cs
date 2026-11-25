namespace Dg.Core.Plugins.Contract;

public interface IPluginTransport : IAsyncDisposable
{
    ValueTask<ReadOnlyMemory<byte>> RequestAsync(
        string route,
        ReadOnlyMemory<byte> body,
        CancellationToken cancellationToken
    );
}

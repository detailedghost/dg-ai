namespace Dg.Core.Plugins.Contract;

public interface IEventSink
{
    ValueTask PublishAsync(string route, ReadOnlyMemory<byte> body, CancellationToken cancellationToken);
}

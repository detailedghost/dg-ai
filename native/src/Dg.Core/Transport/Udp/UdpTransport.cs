using System.Buffers;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading.Channels;
using Dg.Core.Plugins.Contract;

namespace Dg.Core.Transport.Udp;

public sealed class UdpTransport : IEventSink, IAsyncDisposable
{
    public const int DefaultCapacity = 1_024;

    private readonly Channel<byte[]> _queue;
    private readonly UdpClient _client;
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _sender;
    private long _dropped;
    private long _sent;

    public UdpTransport(IPEndPoint remote, int capacity = DefaultCapacity)
    {
        ArgumentNullException.ThrowIfNull(remote);
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);
        if (!IPAddress.IsLoopback(remote.Address))
            throw new PluginContractException(
                "udp-refused",
                $"dg plugin: udp transport refused: {remote.Address} is not loopback. Next: use the http transport with remote = true."
            );
        _queue = Channel.CreateBounded<byte[]>(
            new BoundedChannelOptions(capacity)
            {
                FullMode = BoundedChannelFullMode.Wait,
                SingleReader = true,
                AllowSynchronousContinuations = false,
            }
        );
        _client = new UdpClient(remote.AddressFamily);
        _client.Connect(remote);
        _sender = Task.Run(SendLoopAsync);
    }

    public long Dropped => Interlocked.Read(ref _dropped);

    public long Sent => Interlocked.Read(ref _sent);

    public void Post(in PluginEvent ev)
    {
        var frame = Encode(ev);
        if (frame is null || !_queue.Writer.TryWrite(frame))
            Interlocked.Increment(ref _dropped);
    }

    public async ValueTask DisposeAsync()
    {
        _queue.Writer.TryComplete();
        await _stop.CancelAsync().ConfigureAwait(false);
        try
        {
            await _sender.ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
        _client.Dispose();
        _stop.Dispose();
    }

    internal static byte[]? Encode(in PluginEvent ev)
    {
        var buffer = new ArrayBufferWriter<byte>(PluginProtocol.UdpMaxFrameBytes);
        buffer.GetSpan(PluginProtocol.HeaderBytes);
        buffer.Advance(PluginProtocol.HeaderBytes);
        try
        {
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteString("route"u8, ev.Route);
                writer.WritePropertyName("body"u8);
                if (ev.Body.IsEmpty)
                    writer.WriteNullValue();
                else
                    writer.WriteRawValue(ev.Body.Span, skipInputValidation: false);
                writer.WriteEndObject();
            }
        }
        catch (JsonException)
        {
            return null;
        }
        var total = buffer.WrittenCount;
        if (total > PluginProtocol.UdpMaxFrameBytes)
            return null;
        var frame = buffer.WrittenSpan.ToArray();
        new FrameHeader(
            PluginProtocol.Version,
            FrameEncoding.Json,
            FrameFlags.Event,
            0,
            (uint)(total - PluginProtocol.HeaderBytes)
        ).Write(frame);
        return frame;
    }

    private async Task SendLoopAsync()
    {
        var reader = _queue.Reader;
        try
        {
            await foreach (var frame in reader.ReadAllAsync(_stop.Token).ConfigureAwait(false))
            {
                try
                {
                    await _client.SendAsync(frame, _stop.Token).ConfigureAwait(false);
                    Interlocked.Increment(ref _sent);
                }
                catch (SocketException)
                {
                    Interlocked.Increment(ref _dropped);
                }
            }
        }
        catch (OperationCanceledException) { }
    }
}

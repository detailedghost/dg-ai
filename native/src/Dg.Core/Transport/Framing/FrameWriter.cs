using System.Buffers;
using Dg.Core.Plugins.Contract;

namespace Dg.Core.Transport.Framing;

public static class FrameWriter
{
    public static PooledFrame Encode(FrameEncoding encoding, FrameFlags flags, uint requestId, ReadOnlySpan<byte> payload)
    {
        if (payload.Length > PluginProtocol.MaxPayloadBytes)
            throw FrameHeader.Error(
                "oversize",
                $"payload is {payload.Length} bytes, the limit is {PluginProtocol.MaxPayloadBytes}",
                "send a smaller payload"
            );
        var length = PluginProtocol.HeaderBytes + payload.Length;
        var buffer = ArrayPool<byte>.Shared.Rent(length);
        new FrameHeader(PluginProtocol.Version, encoding, flags, requestId, (uint)payload.Length).Write(buffer);
        payload.CopyTo(buffer.AsSpan(PluginProtocol.HeaderBytes));
        return new PooledFrame(buffer, length);
    }
}

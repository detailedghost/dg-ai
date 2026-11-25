namespace Dg.Core.Plugins.Contract;

public sealed record DecodedFrame(FrameHeader Header, ReadOnlyMemory<byte> Payload);

public static class FrameCodec
{
    public static byte[] Encode(
        FrameEncoding encoding,
        FrameFlags flags,
        uint requestId,
        ReadOnlySpan<byte> payload
    )
    {
        if (payload.Length > PluginProtocol.MaxPayloadBytes)
            throw FrameHeader.Error(
                "oversize",
                $"payload is {payload.Length} bytes, the limit is {PluginProtocol.MaxPayloadBytes}",
                "send a smaller payload"
            );
        var buffer = new byte[PluginProtocol.HeaderBytes + payload.Length];
        new FrameHeader(PluginProtocol.Version, encoding, flags, requestId, (uint)payload.Length).Write(buffer);
        payload.CopyTo(buffer.AsSpan(PluginProtocol.HeaderBytes));
        return buffer;
    }

    public static DecodedFrame Decode(ReadOnlyMemory<byte> bytes)
    {
        var header = FrameHeader.Parse(bytes.Span);
        var end = PluginProtocol.HeaderBytes + (int)header.Length;
        if (bytes.Length < end)
            throw FrameHeader.Error(
                "truncated-payload",
                $"header says {header.Length} payload bytes, got {bytes.Length - PluginProtocol.HeaderBytes}",
                "read the full payload"
            );
        if (bytes.Length > end)
            throw FrameHeader.Error(
                "trailing-bytes",
                $"{bytes.Length - end} bytes follow the payload",
                "split the stream at each header length"
            );
        return new(header, bytes[PluginProtocol.HeaderBytes..end]);
    }
}

using System.Buffers.Binary;

namespace Dg.Core.Plugins.Contract;

public readonly record struct FrameHeader(
    byte Version,
    FrameEncoding Encoding,
    FrameFlags Flags,
    uint RequestId,
    uint Length
)
{
    private const ushort FlagsMask = 0b111;

    public static FrameHeader Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < PluginProtocol.HeaderBytes)
            throw Error(
                "short-header",
                $"got {bytes.Length} bytes, a header is {PluginProtocol.HeaderBytes}",
                "read 12 bytes before you decode"
            );
        var version = bytes[0];
        if (version != PluginProtocol.Version)
            throw Error(
                "bad-version",
                $"version {version}, this dg speaks {PluginProtocol.Version}",
                "update the plugin to protocol 1"
            );
        var encoding = bytes[1];
        if (encoding > (byte)FrameEncoding.MessagePack)
            throw Error(
                "bad-encoding",
                $"encoding {encoding} is not 0 (json) or 1 (msgpack)",
                "negotiate the encoding in hello"
            );
        var flags = BinaryPrimitives.ReadUInt16BigEndian(bytes[2..]);
        if ((flags & ~FlagsMask) != 0)
            throw Error(
                "reserved-flags",
                $"flags 0x{flags:x} set a reserved bit",
                "send zero in every reserved flag bit"
            );
        var length = BinaryPrimitives.ReadUInt32BigEndian(bytes[8..]);
        if (length > PluginProtocol.MaxPayloadBytes)
            throw Error(
                "oversize",
                $"length {length}, the limit is {PluginProtocol.MaxPayloadBytes}",
                "close the connection and send smaller payloads"
            );
        return new(version, (FrameEncoding)encoding, (FrameFlags)flags, BinaryPrimitives.ReadUInt32BigEndian(bytes[4..]), length);
    }

    public void Write(Span<byte> destination)
    {
        destination[0] = Version;
        destination[1] = (byte)Encoding;
        BinaryPrimitives.WriteUInt16BigEndian(destination[2..], (ushort)Flags);
        BinaryPrimitives.WriteUInt32BigEndian(destination[4..], RequestId);
        BinaryPrimitives.WriteUInt32BigEndian(destination[8..], Length);
    }

    internal static PluginContractException Error(string code, string detail, string next) =>
        new(code, $"dg plugin: frame {code}: {detail}. Next: {next}");
}

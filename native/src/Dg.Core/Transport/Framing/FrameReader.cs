using System.Buffers;
using Dg.Core.Plugins.Contract;

namespace Dg.Core.Transport.Framing;

public static class FrameReader
{
    public static bool TryRead(ref ReadOnlySequence<byte> buffer, out Frame frame)
    {
        frame = default;
        if (buffer.Length < PluginProtocol.HeaderBytes)
            return false;

        Span<byte> head = stackalloc byte[PluginProtocol.HeaderBytes];
        var first = buffer.FirstSpan;
        if (first.Length >= PluginProtocol.HeaderBytes)
            first[..PluginProtocol.HeaderBytes].CopyTo(head);
        else
            buffer.Slice(0, PluginProtocol.HeaderBytes).CopyTo(head);

        var header = FrameHeader.Parse(head);
        var total = PluginProtocol.HeaderBytes + (long)header.Length;
        if (buffer.Length < total)
            return false;

        frame = new Frame(header, buffer.Slice(PluginProtocol.HeaderBytes, header.Length));
        buffer = buffer.Slice(total);
        return true;
    }
}

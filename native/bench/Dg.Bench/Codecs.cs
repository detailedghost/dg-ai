using System.Buffers;
using System.Text.Json;
using Dg.Core.Plugins.Contract;
using MessagePack;

namespace Dg.Bench;

internal static class Codecs
{
    private static readonly ArrayBufferWriter<byte> Sink = new(512);
    private static readonly byte[] PackedRequest = PackRequest();

    public static string? Sunk;

    public static byte[] JsonEncode() =>
        JsonSerializer.SerializeToUtf8Bytes(Fixtures.HookRequest, PluginJsonContext.Default.HookDecideRequest);

    public static void JsonDecode(byte[] payload) =>
        Sunk = JsonSerializer.Deserialize(payload, PluginJsonContext.Default.HookDecideRequest)?.Event;

    public static void PackEncode() => PackRequest(Sink);

    public static void PackDecode()
    {
        var reader = new MessagePackReader(PackedRequest);
        string? name = null;
        for (var fields = reader.ReadMapHeader(); fields > 0; fields--)
        {
            var key = reader.ReadString();
            if (key == "input")
            {
                for (var inner = reader.ReadMapHeader(); inner > 0; inner--)
                {
                    reader.ReadString();
                    reader.ReadString();
                }
            }
            else
            {
                var value = reader.ReadString();
                if (key == "event")
                    name = value;
            }
        }
        Sunk = name;
    }

    private static byte[] PackRequest()
    {
        var sink = new ArrayBufferWriter<byte>(512);
        PackRequest(sink);
        return sink.WrittenSpan.ToArray();
    }

    private static void PackRequest(ArrayBufferWriter<byte> sink)
    {
        sink.ResetWrittenCount();
        var writer = new MessagePackWriter(sink);
        writer.WriteMapHeader(3);
        writer.Write("event");
        writer.Write("PreToolUse");
        writer.Write("tool");
        writer.Write("Bash");
        writer.Write("input");
        writer.WriteMapHeader(2);
        writer.Write("command");
        writer.Write("git status --short");
        writer.Write("cwd");
        writer.Write("/home/user/code/project");
        writer.Flush();
    }
}

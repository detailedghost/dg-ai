using System.Buffers;
using System.Text.Json;
using Dg.Core.Plugins.Contract;
using MessagePack;

namespace Dg.Core.Transport.Codec;

public static class MessagePackTranscoder
{
    private const int MaxDepth = 64;

    public static byte[] FromJson(ReadOnlySpan<byte> json)
    {
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions { MaxDepth = MaxDepth });
        }
        catch (JsonException ex)
        {
            throw new PluginContractException("bad-payload", $"payload is not valid JSON: {ex.Message}");
        }
        using (doc)
        {
            var buffer = new ArrayBufferWriter<byte>(json.Length);
            var writer = new MessagePackWriter(buffer);
            Write(ref writer, doc.RootElement);
            writer.Flush();
            return buffer.WrittenSpan.ToArray();
        }
    }

    public static byte[] ToJson(ReadOnlyMemory<byte> messagePack)
    {
        var buffer = new ArrayBufferWriter<byte>(messagePack.Length * 2);
        using var writer = new Utf8JsonWriter(buffer);
        try
        {
            var reader = new MessagePackReader(messagePack);
            Read(ref reader, writer, 0);
            if (!reader.End)
                throw Bad("trailing bytes after the message");
        }
        catch (Exception ex) when (ex is MessagePackSerializationException or ArgumentException or InvalidOperationException)
        {
            throw Bad(ex.Message);
        }
        catch (EndOfStreamException)
        {
            throw Bad("message is truncated");
        }
        writer.Flush();
        return buffer.WrittenSpan.ToArray();
    }

    private static void Write(ref MessagePackWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteMapHeader(element.EnumerateObject().Count());
                foreach (var property in element.EnumerateObject())
                {
                    writer.Write(property.Name);
                    Write(ref writer, property.Value);
                }
                break;
            case JsonValueKind.Array:
                writer.WriteArrayHeader(element.GetArrayLength());
                foreach (var item in element.EnumerateArray())
                    Write(ref writer, item);
                break;
            case JsonValueKind.String:
                writer.Write(element.GetString());
                break;
            case JsonValueKind.Number:
                if (element.TryGetInt64(out var signed))
                    writer.Write(signed);
                else if (element.TryGetUInt64(out var unsigned))
                    writer.Write(unsigned);
                else
                    writer.Write(element.GetDouble());
                break;
            case JsonValueKind.True:
                writer.Write(true);
                break;
            case JsonValueKind.False:
                writer.Write(false);
                break;
            default:
                writer.WriteNil();
                break;
        }
    }

    private static void Read(ref MessagePackReader reader, Utf8JsonWriter writer, int depth)
    {
        if (depth > MaxDepth)
            throw Bad("message is nested too deeply");
        switch (reader.NextMessagePackType)
        {
            case MessagePackType.Map:
                var pairs = reader.ReadMapHeader();
                writer.WriteStartObject();
                for (var i = 0; i < pairs; i++)
                {
                    if (reader.NextMessagePackType != MessagePackType.String)
                        throw Bad("map keys must be strings");
                    writer.WritePropertyName(reader.ReadString()!);
                    Read(ref reader, writer, depth + 1);
                }
                writer.WriteEndObject();
                break;
            case MessagePackType.Array:
                var items = reader.ReadArrayHeader();
                writer.WriteStartArray();
                for (var i = 0; i < items; i++)
                    Read(ref reader, writer, depth + 1);
                writer.WriteEndArray();
                break;
            case MessagePackType.String:
                writer.WriteStringValue(reader.ReadString());
                break;
            case MessagePackType.Integer:
                if (reader.NextCode == MessagePackCode.UInt64)
                    writer.WriteNumberValue(reader.ReadUInt64());
                else
                    writer.WriteNumberValue(reader.ReadInt64());
                break;
            case MessagePackType.Float:
                var number = reader.ReadDouble();
                if (!double.IsFinite(number))
                    throw Bad("numbers must be finite");
                writer.WriteNumberValue(number);
                break;
            case MessagePackType.Boolean:
                writer.WriteBooleanValue(reader.ReadBoolean());
                break;
            case MessagePackType.Nil:
                reader.ReadNil();
                writer.WriteNullValue();
                break;
            default:
                throw Bad($"unsupported MessagePack type {reader.NextMessagePackType}");
        }
    }

    private static PluginContractException Bad(string reason) => new("bad-payload", $"payload is not valid MessagePack: {reason}");
}

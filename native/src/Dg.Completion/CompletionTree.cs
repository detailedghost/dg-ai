using System.Text.Json;

namespace Dg.Completion;

internal static class CompletionTree
{
    public static CompletionNode Parse(ReadOnlyMemory<byte> utf8)
    {
        using var document = JsonDocument.Parse(utf8);
        return ReadNode(document.RootElement);
    }

    private static CompletionNode ReadNode(JsonElement element)
    {
        var name = "";
        string? description = null;
        CompletionNode[]? commands = null;
        CompletionOption[]? options = null;
        string[]? values = null;
        var path = false;
        foreach (var property in element.EnumerateObject())
        {
            if (property.NameEquals("name"u8))
                name = property.Value.GetString() ?? "";
            else if (property.NameEquals("description"u8))
                description = property.Value.GetString();
            else if (property.NameEquals("commands"u8))
                commands = ReadArray(property.Value, ReadNode);
            else if (property.NameEquals("options"u8))
                options = ReadArray(property.Value, ReadOption);
            else if (property.NameEquals("values"u8))
                values = ReadArray(property.Value, static item => item.GetString() ?? "");
            else if (property.NameEquals("path"u8))
                path = property.Value.GetBoolean();
        }

        return new CompletionNode(name, description, commands, options, values, path);
    }

    private static CompletionOption ReadOption(JsonElement element)
    {
        var flags = Array.Empty<string>();
        string? description = null;
        var kind = ValueKind.None;
        string[]? choices = null;
        CompletionNode? mode = null;
        foreach (var property in element.EnumerateObject())
        {
            if (property.NameEquals("flags"u8))
            {
                flags = ReadArray(property.Value, static item => item.GetString() ?? "");
            }
            else if (property.NameEquals("description"u8))
            {
                description = property.Value.GetString();
            }
            else if (property.NameEquals("value"u8) && property.Value.ValueKind == JsonValueKind.Array)
            {
                kind = ValueKind.Choices;
                choices = ReadArray(property.Value, static item => item.GetString() ?? "");
            }
            else if (property.NameEquals("value"u8))
            {
                kind = property.Value.GetString() == "path" ? ValueKind.Path : ValueKind.Any;
            }
            else if (property.NameEquals("mode"u8))
            {
                mode = ReadNode(property.Value);
            }
        }

        return new CompletionOption(flags, description, kind, choices, mode);
    }

    private static T[] ReadArray<T>(JsonElement element, Func<JsonElement, T> read)
    {
        var result = new T[element.GetArrayLength()];
        var index = 0;
        foreach (var item in element.EnumerateArray())
        {
            result[index++] = read(item);
        }

        return result;
    }
}

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
            switch (property.Name)
            {
                case "name":
                    name = property.Value.GetString() ?? "";
                    break;
                case "description":
                    description = property.Value.GetString();
                    break;
                case "commands":
                    commands = ReadArray(property.Value, ReadNode);
                    break;
                case "options":
                    options = ReadArray(property.Value, ReadOption);
                    break;
                case "values":
                    values = ReadArray(property.Value, static item => item.GetString() ?? "");
                    break;
                case "path":
                    path = property.Value.GetBoolean();
                    break;
            }
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
            switch (property.Name)
            {
                case "flags":
                    flags = ReadArray(property.Value, static item => item.GetString() ?? "");
                    break;
                case "description":
                    description = property.Value.GetString();
                    break;
                case "value" when property.Value.ValueKind == JsonValueKind.Array:
                    kind = ValueKind.Choices;
                    choices = ReadArray(property.Value, static item => item.GetString() ?? "");
                    break;
                case "value":
                    kind = property.Value.GetString() == "path" ? ValueKind.Path : ValueKind.Any;
                    break;
                case "mode":
                    mode = ReadNode(property.Value);
                    break;
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

using System.Text.Json;

namespace Dg.Hooks.Engine;

public readonly record struct HookEvent
{
    public string? EventName { get; init; }

    public string? ToolName { get; init; }

    public string? Cwd { get; init; }

    public string? SessionId { get; init; }

    public string? Source { get; init; }

    public string? FilePath { get; init; }

    public string? OldString { get; init; }

    public string? NewString { get; init; }

    public string? Content { get; init; }

    public string? Command { get; init; }

    public string? ResponseFilePath { get; init; }

    public string[] Edits { get; init; }

    public string[] Args { get; init; }

    public HookEvent()
    {
        Edits = [];
        Args = [];
    }

    public static HookEvent Parse(ReadOnlySpan<byte> utf8)
    {
        try
        {
            var reader = new Utf8JsonReader(utf8.StartsWith("\uFEFF"u8) ? utf8[3..] : utf8);
            return reader.Read() && reader.TokenType == JsonTokenType.StartObject
                ? ReadEvent(ref reader)
                : default;
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static HookEvent ReadEvent(ref Utf8JsonReader reader)
    {
        var ev = new HookEvent();
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            if (reader.ValueTextEquals("hook_event_name"u8))
                ev = ev with { EventName = ReadString(ref reader) };
            else if (reader.ValueTextEquals("tool_name"u8))
                ev = ev with { ToolName = ReadString(ref reader) };
            else if (reader.ValueTextEquals("cwd"u8))
                ev = ev with { Cwd = ReadString(ref reader) };
            else if (reader.ValueTextEquals("session_id"u8))
                ev = ev with { SessionId = ReadString(ref reader) };
            else if (reader.ValueTextEquals("source"u8))
                ev = ev with { Source = ReadString(ref reader) };
            else if (reader.ValueTextEquals("tool_input"u8))
                ev = ReadToolInput(ref reader, ev);
            else if (reader.ValueTextEquals("tool_response"u8))
                ev = ReadToolResponse(ref reader, ev);
            else
                SkipValue(ref reader);
        }
        return ev;
    }

    private static HookEvent ReadToolInput(ref Utf8JsonReader reader, HookEvent ev)
    {
        if (!EnterObject(ref reader))
            return ev;
        string? command = null;
        string? cmd = null;
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            if (reader.ValueTextEquals("file_path"u8))
                ev = ev with { FilePath = ReadString(ref reader) };
            else if (reader.ValueTextEquals("old_string"u8))
                ev = ev with { OldString = ReadString(ref reader) };
            else if (reader.ValueTextEquals("new_string"u8))
                ev = ev with { NewString = ReadString(ref reader) };
            else if (reader.ValueTextEquals("content"u8))
                ev = ev with { Content = ReadString(ref reader) };
            else if (reader.ValueTextEquals("command"u8))
                command = ReadString(ref reader);
            else if (reader.ValueTextEquals("cmd"u8))
                cmd = ReadString(ref reader);
            else if (reader.ValueTextEquals("edits"u8))
                ev = ev with { Edits = ReadEdits(ref reader) };
            else
                SkipValue(ref reader);
        }
        return ev with { Command = command ?? cmd };
    }

    private static HookEvent ReadToolResponse(ref Utf8JsonReader reader, HookEvent ev)
    {
        if (!EnterObject(ref reader))
            return ev;
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            if (reader.ValueTextEquals("filePath"u8))
                ev = ev with { ResponseFilePath = ReadString(ref reader) };
            else
                SkipValue(ref reader);
        }
        return ev;
    }

    private static string[] ReadEdits(ref Utf8JsonReader reader)
    {
        if (!reader.Read() || reader.TokenType != JsonTokenType.StartArray)
        {
            SkipCurrent(ref reader);
            return [];
        }
        List<string> edits = [];
        while (reader.Read() && reader.TokenType != JsonTokenType.EndArray)
        {
            if (reader.TokenType != JsonTokenType.StartObject)
            {
                SkipCurrent(ref reader);
                continue;
            }
            while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
            {
                if (!reader.ValueTextEquals("new_string"u8))
                    SkipValue(ref reader);
                else if (ReadString(ref reader) is { } text)
                    edits.Add(text);
            }
        }
        return [.. edits];
    }

    private static bool EnterObject(ref Utf8JsonReader reader)
    {
        if (reader.Read() && reader.TokenType == JsonTokenType.StartObject)
            return true;
        SkipCurrent(ref reader);
        return false;
    }

    private static string? ReadString(ref Utf8JsonReader reader)
    {
        reader.Read();
        if (reader.TokenType == JsonTokenType.String)
            return reader.GetString();
        SkipCurrent(ref reader);
        return null;
    }

    private static void SkipValue(ref Utf8JsonReader reader)
    {
        reader.Read();
        SkipCurrent(ref reader);
    }

    private static void SkipCurrent(ref Utf8JsonReader reader) => reader.Skip();
}

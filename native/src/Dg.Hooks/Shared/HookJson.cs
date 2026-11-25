using System.Text;
using Dg.Hooks.Engine;

namespace Dg.Hooks.Shared;

internal static class HookJson
{
    public static string AdditionalContext(string eventName, string text) =>
        $$$"""{"hookSpecificOutput":{"hookEventName":{{{Quote(eventName)}}},"additionalContext":{{{Quote(text)}}}}}""";

    public static void EmitContext(HookEvent ev, string eventName, string text, Action<string> write)
    {
        if (ev.Sink is { } sink)
            sink.Add(eventName, text);
        else
            write(AdditionalContext(eventName, text));
    }

    public static string Quote(string text)
    {
        StringBuilder json = new(text.Length + 2);
        json.Append('"');
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            switch (c)
            {
                case '"':
                    json.Append("\\\"");
                    break;
                case '\\':
                    json.Append("\\\\");
                    break;
                case '\b':
                    json.Append("\\b");
                    break;
                case '\f':
                    json.Append("\\f");
                    break;
                case '\n':
                    json.Append("\\n");
                    break;
                case '\r':
                    json.Append("\\r");
                    break;
                case '\t':
                    json.Append("\\t");
                    break;
                case < ' ':
                    json.Append("\\u").Append(((int)c).ToString("x4"));
                    break;
                case >= '\uD800' and <= '\uDBFF' when i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]):
                    json.Append(c).Append(text[++i]);
                    break;
                case >= '\uD800' and <= '\uDFFF':
                    json.Append("\\u").Append(((int)c).ToString("x4"));
                    break;
                default:
                    json.Append(c);
                    break;
            }
        }
        return json.Append('"').ToString();
    }
}

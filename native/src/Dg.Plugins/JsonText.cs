using System.Text;

namespace Dg.Plugins;

internal static class JsonText
{
    public static void Quote(StringBuilder sink, string value)
    {
        sink.Append('"');
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            switch (c)
            {
                case '"':
                    sink.Append("\\\"");
                    break;
                case '\\':
                    sink.Append("\\\\");
                    break;
                case '\b':
                    sink.Append("\\b");
                    break;
                case '\f':
                    sink.Append("\\f");
                    break;
                case '\n':
                    sink.Append("\\n");
                    break;
                case '\r':
                    sink.Append("\\r");
                    break;
                case '\t':
                    sink.Append("\\t");
                    break;
                case < ' ':
                    sink.Append("\\u").Append(((int)c).ToString("x4"));
                    break;
                case >= '\ud800' and <= '\udfff' when !IsPaired(value, i):
                    sink.Append("\\u").Append(((int)c).ToString("x4"));
                    break;
                default:
                    sink.Append(c);
                    break;
            }
        }
        sink.Append('"');
    }

    private static bool IsPaired(string value, int index) =>
        char.IsHighSurrogate(value[index])
            ? index + 1 < value.Length && char.IsLowSurrogate(value[index + 1])
            : index > 0 && char.IsHighSurrogate(value[index - 1]);
}

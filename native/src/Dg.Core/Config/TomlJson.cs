using System.Collections;
using System.Globalization;
using System.Text;
using Tomlyn;
using Tomlyn.Model;

namespace Dg.Core.Config;

public static class TomlJson
{
    public static string Stringify(object? value)
    {
        var builder = new StringBuilder();
        Write(builder, value);
        return builder.ToString();
    }

    public static void Write(StringBuilder builder, object? value)
    {
        switch (value)
        {
            case null:
                builder.Append("null");
                break;
            case string text:
                WriteString(builder, text);
                break;
            case bool flag:
                builder.Append(flag ? "true" : "false");
                break;
            case long integer:
                builder.Append(integer.ToString(CultureInfo.InvariantCulture));
                break;
            case double number:
                WriteNumber(builder, number);
                break;
            case TomlDateTime moment:
                WriteString(
                    builder,
                    moment.DateTime.UtcDateTime.ToString(
                        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                        CultureInfo.InvariantCulture
                    )
                );
                break;
            case TomlTable table:
                builder.Append('{');
                var first = true;
                foreach (var (name, item) in table)
                {
                    if (!first)
                        builder.Append(',');
                    first = false;
                    WriteString(builder, name);
                    builder.Append(':');
                    Write(builder, item);
                }
                builder.Append('}');
                break;
            case IEnumerable items:
                builder.Append('[');
                var firstItem = true;
                foreach (var item in items)
                {
                    if (!firstItem)
                        builder.Append(',');
                    firstItem = false;
                    Write(builder, item);
                }
                builder.Append(']');
                break;
            default:
                builder.Append("null");
                break;
        }
    }

    private static void WriteNumber(StringBuilder builder, double number)
    {
        if (!double.IsFinite(number))
            builder.Append("null");
        else if (number == Math.Floor(number) && Math.Abs(number) < 1e15)
            builder.Append(((long)number).ToString(CultureInfo.InvariantCulture));
        else
            builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
    }

    private static void WriteString(StringBuilder builder, string text)
    {
        builder.Append('"');
        foreach (var character in text)
        {
            switch (character)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\b':
                    builder.Append("\\b");
                    break;
                case '\f':
                    builder.Append("\\f");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                case < ' ':
                    builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    break;
                default:
                    builder.Append(character);
                    break;
            }
        }
        builder.Append('"');
    }
}

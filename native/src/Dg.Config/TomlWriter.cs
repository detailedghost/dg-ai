using System.Collections;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Tomlyn.Model;

namespace Dg.Config;

internal static partial class TomlWriter
{
    private const double MaxSafeInteger = 9007199254740991;

    [GeneratedRegex(@"^[a-zA-Z0-9\-_]+\z")]
    private static partial Regex BareKey();

    public static string Stringify(TomlTable document) => $"{Table("", document, "").Trim()}\n";

    private static string Table(string tableKey, TomlTable table, string prefix)
    {
        var preamble = new StringBuilder();
        var tables = new StringBuilder();
        foreach (var (name, value) in table)
        {
            var key = FormatKey(name);
            var path = prefix.Length > 0 ? $"{prefix}.{key}" : key;
            if (value is IEnumerable and not string and not TomlTable && IsArrayOfTables(value))
            {
                Separate(tables).Append(ArrayTable((IEnumerable)value, path));
            }
            else if (value is TomlTable child)
            {
                Separate(tables).Append(Table(path, child, path));
            }
            else
            {
                preamble.Append(key).Append(" = ").Append(Value(value)).Append('\n');
            }
        }
        var head = preamble.ToString();
        if (tableKey.Length > 0 && (head.Length > 0 || tables.Length == 0))
            head = head.Length > 0 ? $"[{tableKey}]\n{head}" : $"[{tableKey}]";
        if (head.Length > 0 && tables.Length > 0)
            return $"{head}\n{tables}";
        return head.Length > 0 ? head : tables.ToString();
    }

    private static StringBuilder Separate(StringBuilder builder) => builder.Length > 0 ? builder.Append('\n') : builder;

    private static string ArrayTable(IEnumerable items, string key)
    {
        var result = new StringBuilder();
        foreach (TomlTable item in items)
        {
            if (result.Length > 0)
                result.Append('\n');
            result.Append("[[").Append(key).Append("]]\n").Append(Table("", item, key));
        }
        return result.ToString();
    }

    private static bool IsArrayOfTables(object? value)
    {
        var any = false;
        foreach (var item in (IEnumerable)value!)
        {
            if (item is not TomlTable)
                return false;
            any = true;
        }
        return any;
    }

    private static string Value(object? value) =>
        value switch
        {
            string text => Quote(text),
            bool flag => flag ? "true" : "false",
            long integer => Integer(integer),
            double number => Number(number),
            TomlTable inline => InlineTable(inline),
            IEnumerable items => Array(items),
            _ => value?.ToString() ?? "",
        };

    private static string Integer(long value) =>
        Math.Abs((double)value) <= MaxSafeInteger
            ? value.ToString(CultureInfo.InvariantCulture)
            : ((double)value).ToString("F1", CultureInfo.InvariantCulture);

    private static string Number(double number)
    {
        if (double.IsNaN(number))
            return "nan";
        if (double.IsPositiveInfinity(number))
            return "inf";
        if (double.IsNegativeInfinity(number))
            return "-inf";
        if (number == Math.Floor(number))
            return Math.Abs(number) <= MaxSafeInteger
                ? ((long)number).ToString(CultureInfo.InvariantCulture)
                : number.ToString("F1", CultureInfo.InvariantCulture);
        return Exponent(number.ToString("R", CultureInfo.InvariantCulture));
    }

    private static string Exponent(string text)
    {
        var at = text.IndexOf('E', StringComparison.Ordinal);
        if (at < 0)
            return text;
        var sign = text[at + 1];
        var digits = text[(at + 2)..].TrimStart('0');
        return $"{text[..at]}e{sign}{(digits.Length == 0 ? "0" : digits)}";
    }

    private static string InlineTable(TomlTable table)
    {
        if (table.Count == 0)
            return "{}";
        var parts = new List<string>(table.Count);
        foreach (var (name, value) in table)
            parts.Add($"{FormatKey(name)} = {Value(value)}");
        return $"{{ {string.Join(", ", parts)} }}";
    }

    private static string Array(IEnumerable items)
    {
        var parts = new List<string>();
        foreach (var item in items)
            parts.Add(Value(item));
        return parts.Count == 0 ? "[]" : $"[ {string.Join(", ", parts)} ]";
    }

    private static string FormatKey(string key) => BareKey().IsMatch(key) ? key : Quote(key);

    private static string Quote(string text)
    {
        var builder = new StringBuilder(text.Length + 2).Append('"');
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
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
                case '\u007f':
                    builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    break;
                default:
                    builder.Append(character);
                    break;
            }
        }
        return builder.Append('"').ToString();
    }
}

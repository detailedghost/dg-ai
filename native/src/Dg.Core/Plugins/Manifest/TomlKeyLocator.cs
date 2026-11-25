using System.Text;
using System.Text.RegularExpressions;

namespace Dg.Core.Plugins.Manifest;

internal static partial class TomlKeyLocator
{
    [GeneratedRegex(@"^\[\[?([^\]]+)\]\]?")]
    private static partial Regex Header();

    [GeneratedRegex(@"^((?:""[^""]*""|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=")]
    private static partial Regex Assign();

    public static int LineOf(string text, string key)
    {
        var table = new List<string>();
        var near = 0;
        var index = 0;
        foreach (var line in text.Split('\n'))
        {
            index++;
            var raw = line.Trim();
            if (Header().Match(raw) is { Success: true } header)
            {
                table = SplitKey(header.Groups[1].Value);
                var name = string.Join('.', table);
                if (name == key)
                    return index;
                if (near == 0 && key.StartsWith(name + ".", StringComparison.Ordinal))
                    near = index;
                continue;
            }
            if (Assign().Match(raw) is not { Success: true } assign)
                continue;
            var full = string.Join('.', table.Concat(SplitKey(assign.Groups[1].Value)));
            if (full == key)
                return index;
            if (key.StartsWith(full + ".", StringComparison.Ordinal))
                near = index;
        }
        return near == 0 ? 1 : near;
    }

    private static List<string> SplitKey(string raw)
    {
        List<string> parts = [];
        var current = new StringBuilder();
        var quote = '\0';
        foreach (var ch in raw)
        {
            if (quote != '\0')
            {
                if (ch == quote)
                    quote = '\0';
                else
                    current.Append(ch);
            }
            else if (ch is '"' or '\'')
                quote = ch;
            else if (ch == '.')
            {
                parts.Add(current.ToString().Trim());
                current.Clear();
            }
            else
                current.Append(ch);
        }
        parts.Add(current.ToString().Trim());
        return parts;
    }
}

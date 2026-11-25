using System.Text;
using System.Text.RegularExpressions;

namespace Dg.Core.Config;

public static partial class ConfigLines
{
    [GeneratedRegex(@"^\[\[?([^\]]+)\]\]?")]
    private static partial Regex Header();

    [GeneratedRegex(@"^((?:""[^""]*""|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=")]
    private static partial Regex Assign();

    [GeneratedRegex(@"\r?\n")]
    private static partial Regex LineBreak();

    public static int LineOfKey(string text, string key)
    {
        var lines = LineBreak().Split(text);
        string[] table = [];
        var near = 0;
        for (var index = 0; index < lines.Length; index++)
        {
            var raw = lines[index].Trim();
            if (Header().Match(raw) is { Success: true } header)
            {
                table = SplitKey(header.Groups[1].Value);
                var name = string.Join('.', table);
                if (name == key)
                    return index + 1;
                if (near == 0 && key.StartsWith(name + ".", StringComparison.Ordinal))
                    near = index + 1;
                continue;
            }
            if (Assign().Match(raw) is not { Success: true } assign)
                continue;
            var full = string.Join('.', [.. table, .. SplitKey(assign.Groups[1].Value)]);
            if (full == key)
                return index + 1;
            if (key.StartsWith(full + ".", StringComparison.Ordinal))
                near = index + 1;
        }
        return near != 0 ? near : 1;
    }

    private static string[] SplitKey(string raw)
    {
        List<string> parts = [];
        var current = new StringBuilder();
        var quote = '\0';
        foreach (var character in raw)
        {
            if (quote != '\0')
            {
                if (character == quote)
                    quote = '\0';
                else
                    current.Append(character);
            }
            else if (character is '"' or '\'')
                quote = character;
            else if (character == '.')
            {
                parts.Add(current.ToString().Trim());
                current.Clear();
            }
            else
                current.Append(character);
        }
        parts.Add(current.ToString().Trim());
        return [.. parts];
    }
}

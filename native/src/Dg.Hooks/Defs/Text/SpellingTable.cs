namespace Dg.Hooks.Defs.Text;

internal sealed class SpellingTable
{
    private readonly Dictionary<string, string>.AlternateLookup<ReadOnlySpan<char>> _lookup;
    private readonly int _longestKey;

    private SpellingTable(Dictionary<string, string> map)
    {
        _lookup = map.GetAlternateLookup<ReadOnlySpan<char>>();
        foreach (var key in map.Keys)
            _longestKey = Math.Max(_longestKey, key.Length);
    }

    public static SpellingTable For(string locale)
    {
        var usLocale = locale == "en-US";
        Dictionary<string, string> map = new(StringComparer.Ordinal);
        foreach (var raw in SpellingPairs.Text.Split('\n'))
        {
            var line = raw.AsSpan().Trim();
            var first = Next(ref line);
            var second = Next(ref line);
            if (first.IsEmpty || second.IsEmpty)
                continue;
            var usOnly = !Next(ref line).IsEmpty;
            if (usLocale)
                map[first.ToString()] = second.ToString();
            else if (!usOnly)
                map[second.ToString()] = first.ToString();
        }
        return new SpellingTable(map);
    }

    public bool TryFind(ReadOnlySpan<char> token, out string fix)
    {
        fix = "";
        if (token.Length > _longestKey)
            return false;
        Span<char> lower = stackalloc char[token.Length];
        for (var i = 0; i < token.Length; i++)
            lower[i] = token[i] is >= 'A' and <= 'Z' ? (char)(token[i] + 32) : token[i];
        return _lookup.TryGetValue(lower, out fix!);
    }

    private static ReadOnlySpan<char> Next(ref ReadOnlySpan<char> line)
    {
        line = line.TrimStart();
        var end = 0;
        while (end < line.Length && !char.IsWhiteSpace(line[end]))
            end++;
        var token = line[..end];
        line = line[end..];
        return token;
    }
}

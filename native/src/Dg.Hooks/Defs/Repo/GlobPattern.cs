namespace Dg.Hooks.Defs.Repo;

internal static class GlobPattern
{
    public static bool IsMatch(string pattern, string path) =>
        MatchSegments(pattern.Split('/'), 0, path.Split('/'), 0);

    private static bool MatchSegments(string[] pattern, int p, string[] path, int s)
    {
        if (p == pattern.Length)
            return s == path.Length;
        if (pattern[p] != "**")
            return s < path.Length
                && MatchSegment(pattern[p], path[s])
                && MatchSegments(pattern, p + 1, path, s + 1);
        if (p == pattern.Length - 1)
            return s < path.Length;
        for (var skip = s; skip <= path.Length; skip++)
            if (MatchSegments(pattern, p + 1, path, skip))
                return true;
        return false;
    }

    private static bool MatchSegment(ReadOnlySpan<char> pattern, ReadOnlySpan<char> text)
    {
        var star = pattern.IndexOf('*');
        if (star < 0)
            return pattern.SequenceEqual(text);
        var head = pattern[..star];
        var rest = pattern[(star + 1)..];
        if (!text.StartsWith(head, StringComparison.Ordinal))
            return false;
        text = text[head.Length..];
        for (var i = 0; i <= text.Length; i++)
            if (MatchSegment(rest, text[i..]))
                return true;
        return false;
    }
}

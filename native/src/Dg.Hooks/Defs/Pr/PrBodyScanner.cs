using Dg.Hooks.Shared;
using System.Buffers;
using System.Text;
using System.Text.RegularExpressions;

namespace Dg.Hooks.Defs.Pr;

internal readonly record struct Finding(double Line, string Message);

internal static partial class PrBodyScanner
{
    private const int MinProseWords = 4;
    private const int MinBodyWords = 12;
    private const int LowerStackChars = 512;

    private static readonly string[] Filler =
    [
        "comprehensive",
        "seamless",
        "cutting-edge",
        "best-in-class",
        "state-of-the-art",
        "delve",
        "game-chang",
        "revolutioniz",
        "synerg",
        "holistic",
        "effortless",
    ];

    [GeneratedRegex(@"\A<!-- /chain:(?:start|end) -->\z")]
    private static partial Regex ChainComment();

    [GeneratedRegex(@"(?:\A|[^A-Za-z0-9])(?:TBD|TODO|FIXME|XXX)(?:[^A-Za-z0-9]|\z)")]
    private static partial Regex Marker();

    [GeneratedRegex(@"\{\{|\[describe|\[explain|<placeholder>")]
    private static partial Regex Placeholder();

    [GeneratedRegex(@"(?:Fixes|Closes|Resolves)[ \t]*#[ \t]*(?:\z|[^0-9])")]
    private static partial Regex EmptyIssue();

    [GeneratedRegex(@"\A(?:https?://|!\[|\[!\[)")]
    private static partial Regex Link();

    [GeneratedRegex(@"\A(?:[-*+]|[0-9]+\.)[ \t]")]
    private static partial Regex Bullet();

    [GeneratedRegex(@"\ACo-[Aa]uthored-[Bb]y:")]
    private static partial Regex Trailer();

    [GeneratedRegex(@"[.!?]+[ \t]+")]
    private static partial Regex SentenceBreak();

    public static List<Finding> Scan(string body, double maxSentence)
    {
        List<Finding> findings = [];
        var fence = false;
        var totalWords = 0;
        var firstBullet = 0;
        var firstProse = 0;
        StringBuilder paragraph = new();
        var paragraphLine = 0;

        void Flush()
        {
            if (paragraph.Length == 0)
            {
                paragraphLine = 0;
                return;
            }
            var text = paragraph.ToString();
            var start = 0;
            foreach (var match in SentenceBreak().EnumerateMatches(text))
            {
                CheckSentence(text.AsSpan(start, match.Index - start), paragraphLine, maxSentence, findings);
                start = match.Index + match.Length;
            }
            CheckSentence(text.AsSpan(start), paragraphLine, maxSentence, findings);
            char[]? rented = null;
            Span<char> lower = text.Length <= LowerStackChars
                ? stackalloc char[LowerStackChars]
                : rented = ArrayPool<char>.Shared.Rent(text.Length);
            try
            {
                var lowered = lower[..text.AsSpan().ToLowerInvariant(lower)];
                foreach (var word in Filler)
                    if (lowered.Contains(word, StringComparison.Ordinal))
                        findings.Add(new Finding(paragraphLine, $"marketing filler: '{word}' - say what it actually does"));
            }
            finally
            {
                if (rented is not null)
                    ArrayPool<char>.Shared.Return(rented);
            }
            paragraph.Clear();
            paragraphLine = 0;
        }

        var lines = body.AsSpan().TrimEnd('\n');
        var index = 0;
        foreach (var range in lines.Split('\n'))
        {
            var lineNo = ++index;
            var raw = lines[range];
            var line = JsText.Trim(raw.Length > 0 && raw[^1] == '\r' ? raw[..^1] : raw);
            if (line.StartsWith("```", StringComparison.Ordinal) || line.StartsWith("~~~", StringComparison.Ordinal))
            {
                fence = !fence;
                continue;
            }
            var words = JsText.Words(line);
            if (fence)
            {
                totalWords += words;
                continue;
            }
            if (line.Contains("<!--", StringComparison.Ordinal) && !ChainComment().IsMatch(line))
                findings.Add(new Finding(lineNo, "unexpanded template comment - delete it or replace it with real text"));
            if (Marker().IsMatch(line))
                findings.Add(new Finding(lineNo, "placeholder marker left in the body"));
            if (Placeholder().IsMatch(line))
                findings.Add(new Finding(lineNo, "unfilled template placeholder"));
            if (EmptyIssue().IsMatch(line))
                findings.Add(new Finding(lineNo, "issue reference with no issue number"));

            if (line.IsEmpty)
            {
                Flush();
                continue;
            }
            if (line[0] is '|' or '>')
                continue;
            if (line.Contains("Generated with [Claude Code]", StringComparison.Ordinal))
                continue;
            if (Trailer().IsMatch(line) || Link().IsMatch(line))
                continue;

            var bullet = Bullet().IsMatch(line);
            if (bullet && firstBullet == 0)
                firstBullet = lineNo;
            if (!line.StartsWith('#'))
                totalWords += words;
            if (line.StartsWith('#') || bullet)
                continue;

            if (words >= MinProseWords && firstProse == 0)
                firstProse = lineNo;
            paragraph.Append(' ').Append(line);
            if (paragraphLine == 0)
                paragraphLine = lineNo;
        }
        Flush();

        if (firstProse == 0 && totalWords >= MinBodyWords)
            findings.Add(
                new Finding(
                    1,
                    "no prose summary - the body is headings, bullets, and code with no explanatory sentence"
                )
            );
        else if (firstBullet > 0 && firstProse > firstBullet)
            findings.Add(
                new Finding(firstBullet, "bullets start before any prose - open with a sentence saying what changed and why")
            );
        return findings;
    }

    public static void SortByLine(List<Finding> findings)
    {
        for (var i = 1; i < findings.Count; i++)
        {
            var item = findings[i];
            var j = i - 1;
            while (j >= 0 && Compare(findings[j], item) > 0)
            {
                findings[j + 1] = findings[j];
                j--;
            }
            findings[j + 1] = item;
        }
    }

    private static double Compare(Finding a, Finding b)
    {
        var diff = a.Line - b.Line;
        return double.IsNaN(diff) ? 0 : diff;
    }

    private static void CheckSentence(ReadOnlySpan<char> sentence, int line, double maxSentence, List<Finding> findings)
    {
        var count = JsText.Words(sentence);
        if (count > maxSentence)
            findings.Add(new Finding(line, $"sentence runs {count} words - split it into shorter ones"));
    }
}

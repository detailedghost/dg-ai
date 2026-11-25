using Dg.Hooks.Shared;
using System.Text.RegularExpressions;

namespace Dg.Hooks.Defs.Pr;

internal static partial class AiCoauthors
{
    private const string Space = @"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\uFEFF]";
    private const string CommentChars = "#;@!$%^&|:";

    [GeneratedRegex(@"(?<![A-Za-z0-9_])(?:claude|codex|grok|copilot|openai|gemini|anthropic|gpt|chatgpt)(?![A-Za-z0-9_])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AiName();

    [GeneratedRegex(@"\A(?:noreply@(?:anthropic\.com|openai\.com|x\.ai|google\.com)|cursoragent@cursor\.com)\z|\[bot\]@", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AiEmail();

    [GeneratedRegex("no-?reply", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex NoreplyEmail();

    [GeneratedRegex(@"\A(?<name>[^\n\r\u2028\u2029]*?)" + Space + @"*<(?<email>[^>]*)>" + Space + @"*\z")]
    private static partial Regex Identity();

    [GeneratedRegex(@"\Aco-authored-by:" + Space + @"*(?<identity>[^\n]*)\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Coauthor();

    [GeneratedRegex(@"\A(?:[A-Za-z][A-Za-z0-9_-]*|BREAKING CHANGE):")]
    private static partial Regex Trailer();

    [GeneratedRegex(@"\A" + Space + @"+[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\uFEFF]")]
    private static partial Regex Continuation();

    [GeneratedRegex(@"(?<![^\n\r\u2028\u2029])(?<char>[#;@!$%^&|:]) -{24} >8 -{24}(?![^\n\r\u2028\u2029])")]
    private static partial Regex ScissorsLine();

    public static bool IsAiCoauthor(string identity)
    {
        var parts = Identity().Match(JsText.Trim(identity));
        var name = parts.Success ? parts.Groups["name"].Value : identity;
        var email = parts.Success ? JsText.Trim(parts.Groups["email"].Value) : "";
        if (AiEmail().IsMatch(email))
            return true;
        return AiName().IsMatch(name) && (email == "" || NoreplyEmail().IsMatch(email));
    }

    public static string Strip(string message, string commentChar)
    {
        var lines = message.Split('\n');
        var scissors = $"{commentChar} {new string('-', 24)} >8 {new string('-', 24)}";
        var cut = Array.FindIndex(lines, line => JsText.StripOneCarriageReturn(line) == scissors);
        var end = cut == -1 ? lines.Length : cut;
        while (end > 0)
        {
            var line = lines[end - 1];
            if (!JsText.IsBlank(line) && !IsComment(line, commentChar))
                break;
            end--;
        }
        var content = lines[..end];
        var start = Array.FindLastIndex(content, JsText.IsBlank) + 1;
        var entries = start == 0 ? null : TrailerEntries(content[start..], commentChar);
        if (entries is null)
            return message;

        HashSet<List<string>> removed = new(ReferenceEqualityComparer.Instance);
        foreach (var entry in entries)
        {
            List<string> text = [];
            foreach (var line in entry)
                if (!IsComment(line, commentChar))
                    text.Add(JsText.StripOneCarriageReturn(line));
            if (IsAiTrailer(string.Join(' ', text)))
                removed.Add(entry);
        }
        if (removed.Count == 0)
            return message;

        List<string> kept = [];
        foreach (var entry in entries)
        {
            if (!removed.Contains(entry))
                kept.AddRange(entry);
            else
                foreach (var line in entry)
                    if (IsComment(line, commentChar))
                        kept.Add(line);
        }
        List<string> before = [.. content[..start]];
        if (kept.Count == 0)
            while (before.Count > 0 && JsText.IsBlank(before[^1]))
                before.RemoveAt(before.Count - 1);
        var tail = end < lines.Length ? $"\n{string.Join('\n', lines[end..])}" : "";
        return $"{string.Join('\n', before.Concat(kept))}{tail}";
    }

    public static string AutoCommentChar(string message)
    {
        var scissors = ScissorsLine().Match(message);
        if (scissors.Success)
            return scissors.Groups["char"].Value;
        var lines = message.Split('\n');
        var last = Array.FindLast(lines, line => !JsText.IsBlank(line));
        if (!string.IsNullOrEmpty(last) && CommentChars.Contains(last[0], StringComparison.Ordinal))
            return last[..1];
        foreach (var candidate in CommentChars)
            if (!Array.Exists(lines, line => line.StartsWith(candidate)))
                return candidate.ToString();
        return "#";
    }

    private static bool IsComment(string line, string commentChar) =>
        line.StartsWith(commentChar, StringComparison.Ordinal);

    private static bool IsAiTrailer(string line)
    {
        var match = Coauthor().Match(line);
        return match.Success && IsAiCoauthor(match.Groups["identity"].Value);
    }

    private static List<List<string>>? TrailerEntries(string[] block, string commentChar)
    {
        List<List<string>> entries = [];
        foreach (var line in block)
        {
            if (IsComment(line, commentChar))
            {
                if (entries.Count > 0)
                    entries[^1].Add(line);
                else
                    entries.Add([line]);
            }
            else if (Trailer().IsMatch(line))
            {
                entries.Add([line]);
            }
            else if (Continuation().IsMatch(line) && entries.Count > 0)
            {
                entries[^1].Add(line);
            }
            else
            {
                return null;
            }
        }
        return entries;
    }
}

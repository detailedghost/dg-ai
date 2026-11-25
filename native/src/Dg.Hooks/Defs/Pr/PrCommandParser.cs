using System.Buffers;
using System.Text;
using System.Text.RegularExpressions;

namespace Dg.Hooks.Defs.Pr;

[Flags]
internal enum PrAction
{
    None = 0,
    Create = 1,
    Edit = 2,
    Update = 4,
}

internal readonly record struct ShellItem(string Text, List<string> Nested, bool Subshell);

internal readonly record struct PrCall(string Source, string? Cwd);

internal static partial class PrCommandParser
{
    private const int MaxDepth = 4;
    private static readonly SearchValues<char> SplitChars = SearchValues.Create(";&|)");
    private static readonly SearchValues<char> HashBoundary = SearchValues.Create(";&|()");

    [GeneratedRegex(@"\A[A-Za-z_][A-Za-z0-9_]*=")]
    private static partial Regex Assignment();

    [GeneratedRegex(@"\G<<(-?)[ \t]*(['""]?)([A-Za-z_][A-Za-z0-9_]*)\2")]
    private static partial Regex Heredoc();

    [GeneratedRegex(@"\A-[A-Za-z]*c[A-Za-z]*\z")]
    private static partial Regex ShellFlag();

    public static bool InvokesPr(string command, PrAction actions) =>
        Invocations(command, actions, null).Count > 0;

    public static List<PrCall> Invocations(string command, PrAction actions, string? cwd, int depth = 0)
    {
        List<PrCall> found = [];
        if (depth > MaxDepth)
            return found;
        var dir = cwd;
        foreach (var item in CommandSegments(command))
        {
            if (item.Subshell)
            {
                found.AddRange(Invocations(item.Text, actions, dir, depth + 1));
                continue;
            }
            var words = ShellWords(item.Text);
            if (MatchesPr(words, actions))
                found.Add(new PrCall(item.Text, dir));
            if (ShellScript(words) is { } inner)
                found.AddRange(Invocations(inner, actions, dir, depth + 1));
            foreach (var script in item.Nested)
                found.AddRange(Invocations(script, actions, dir, depth + 1));
            dir = ChangedDir(words, dir);
        }
        return found;
    }

    public static List<ShellItem> CommandSegments(string script)
    {
        var src = script.Replace("\\\n", "", StringComparison.Ordinal);
        List<ShellItem> items = [];
        var at = 0;
        while (at < src.Length)
        {
            while (at < src.Length && (JsText.IsSpace(src[at]) || SplitChars.Contains(src[at])))
                at++;
            if (at >= src.Length)
                break;
            if (src[at] == '(')
            {
                var sub = Scan(src, at + 1, ')', false);
                items.Add(new ShellItem(JsText.Slice(src, at + 1, sub.End), [], true));
                at = sub.End + 1;
                continue;
            }
            var part = Scan(src, at, '\0', true);
            items.Add(new ShellItem(JsText.Slice(src, at, part.End), part.Inner, false));
            at = part.End + 1;
        }
        return items;
    }

    public static List<string> ShellWords(string source)
    {
        List<string> words = [];
        var current = new StringBuilder();
        var started = false;
        var quote = '\0';
        for (var i = 0; i < source.Length; i++)
        {
            var c = source[i];
            if (quote == '\0')
            {
                if (c is '\'' or '"')
                {
                    quote = c;
                    started = true;
                }
                else if (c == '\\')
                {
                    i++;
                    if (i >= source.Length || source[i] != '\n')
                    {
                        if (i < source.Length)
                            current.Append(source[i]);
                        started = true;
                    }
                }
                else if (c is ' ' or '\t' or '\n')
                {
                    if (started)
                        words.Add(current.ToString());
                    current.Clear();
                    started = false;
                }
                else
                {
                    current.Append(c);
                    started = true;
                }
            }
            else if (c == quote)
            {
                quote = '\0';
            }
            else if (quote == '"' && c == '\\' && (i + 1 >= source.Length || source[i + 1] is '$' or '`' or '"' or '\\' or '\n'))
            {
                i++;
                if (i < source.Length && source[i] != '\n')
                    current.Append(source[i]);
            }
            else
            {
                current.Append(c);
                started = true;
            }
        }
        if (started)
            words.Add(current.ToString());
        return words;
    }

    private readonly record struct Scanned(int End, List<string> Inner);

    private readonly record struct PendingHeredoc(string Delimiter, bool Tabs);

    private static int SkipHeredoc(string src, int start, string delimiter, bool tabs)
    {
        var at = start;
        while (at < src.Length)
        {
            var nl = src.IndexOf('\n', at);
            var line = JsText.Slice(src, at, nl < 0 ? src.Length : nl);
            var next = nl < 0 ? src.Length : nl + 1;
            if ((tabs ? line.TrimStart('\t') : line) == delimiter)
                return next;
            at = next;
        }
        return src.Length;
    }

    private static int Substitution(string src, int at, List<string> inner)
    {
        var backtick = src[at] == '`';
        var start = at + (backtick ? 1 : 2);
        var sub = Scan(src, start, backtick ? '`' : ')', false);
        inner.Add(JsText.Slice(src, start, sub.End));
        inner.AddRange(sub.Inner);
        return sub.End + 1;
    }

    private static int ScanDouble(string src, int start, List<string> inner)
    {
        var at = start;
        while (at < src.Length)
        {
            var c = src[at];
            if (c == '\\')
                at += 2;
            else if (c == '"')
                return at + 1;
            else if (c == '`' || (c == '$' && At(src, at + 1) == '('))
                at = Substitution(src, at, inner);
            else
                at++;
        }
        return src.Length;
    }

    private static char At(string text, int index) => index >= 0 && index < text.Length ? text[index] : '\0';

    private static Scanned Scan(string src, int start, char close, bool split)
    {
        List<string> inner = [];
        List<PendingHeredoc> heredocs = [];
        var at = start;
        while (at < src.Length)
        {
            var c = src[at];
            if (c == '\\')
            {
                at += 2;
                continue;
            }
            if (close != '\0' && c == close)
                return new Scanned(at, inner);
            if (split && SplitChars.Contains(c))
                return new Scanned(at, inner);
            if (c == '#' && (at == start || JsText.IsSpace(src[at - 1]) || HashBoundary.Contains(src[at - 1])))
            {
                var nl = src.IndexOf('\n', at);
                at = nl < 0 ? src.Length : nl;
                continue;
            }
            if (c == '\n')
            {
                if (heredocs.Count > 0)
                {
                    var body = at + 1;
                    foreach (var heredoc in heredocs)
                        body = SkipHeredoc(src, body, heredoc.Delimiter, heredoc.Tabs);
                    heredocs.Clear();
                    if (split)
                        return new Scanned(body >= src.Length ? src.Length : body - 1, inner);
                    at = body;
                    continue;
                }
                if (split)
                    return new Scanned(at, inner);
                at++;
                continue;
            }
            if (c == '\'')
            {
                var end = src.IndexOf('\'', at + 1);
                at = end < 0 ? src.Length : end + 1;
            }
            else if (c == '"')
            {
                at = ScanDouble(src, at + 1, inner);
            }
            else if ((c == '`' && close != '`') || (c == '$' && At(src, at + 1) == '('))
            {
                at = Substitution(src, at, inner);
            }
            else if (c == '(' && !split)
            {
                var sub = Scan(src, at + 1, ')', false);
                inner.Add(JsText.Slice(src, at + 1, sub.End));
                inner.AddRange(sub.Inner);
                at = sub.End + 1;
            }
            else if (c == '<' && At(src, at + 1) == '<' && At(src, at + 2) != '<')
            {
                var match = Heredoc().Match(src, at);
                if (match.Success)
                    heredocs.Add(new PendingHeredoc(match.Groups[3].Value, match.Groups[1].Value == "-"));
                at += match.Success ? match.Length : 2;
            }
            else
            {
                at++;
            }
        }
        return new Scanned(src.Length, inner);
    }

    private static bool TakesValueFlag(string word) =>
        (word.Length == 2 && word[0] == '-' && char.IsAsciiLetter(word[1])) || word is "--repo" or "--hostname";

    private static int SkipFlags(List<string> words, int start, string stop)
    {
        var at = start;
        while (at < words.Count && words[at].StartsWith('-'))
        {
            var takesValue =
                TakesValueFlag(words[at])
                && at + 1 < words.Count
                && !words[at + 1].StartsWith('-')
                && words[at + 1] != stop;
            at += takesValue ? 2 : 1;
        }
        return at;
    }

    private static int CommandStart(List<string> words)
    {
        var at = 0;
        while (at < words.Count)
        {
            var word = words[at];
            if (Assignment().IsMatch(word) || word is "if" or "then" or "else" or "elif" or "do" or "while" or "until" or "!" or "{")
            {
                at++;
            }
            else if (word is "sudo" or "env" or "command" or "time" or "exec" or "nice")
            {
                at++;
                while (at < words.Count && (words[at].StartsWith('-') || Assignment().IsMatch(words[at])))
                    at++;
            }
            else
            {
                return at;
            }
        }
        return at;
    }

    private static string? WordAt(List<string> words, int index) => index < words.Count ? words[index] : null;

    private static bool MatchesPr(List<string> words, PrAction actions)
    {
        var at = CommandStart(words);
        var noun = WordAt(words, at) switch
        {
            "gh" => "pr",
            "glab" => "mr",
            _ => null,
        };
        if (noun is null)
            return false;
        var nounAt = SkipFlags(words, at + 1, noun);
        if (WordAt(words, nounAt) != noun)
            return false;
        var action = WordAt(words, SkipFlags(words, nounAt + 1, "")) switch
        {
            "create" => PrAction.Create,
            "edit" => PrAction.Edit,
            "update" => PrAction.Update,
            _ => PrAction.None,
        };
        return (actions & action) != PrAction.None;
    }

    private static string? ShellScript(List<string> words)
    {
        var at = CommandStart(words);
        var tool = WordAt(words, at) ?? "";
        var name = tool[(tool.LastIndexOf('/') + 1)..];
        if (name is not ("sh" or "bash" or "zsh" or "dash"))
            return null;
        for (var i = at + 1; i < words.Count; i++)
        {
            var word = words[i];
            if (!word.StartsWith('-'))
                return null;
            if (ShellFlag().IsMatch(word))
                return WordAt(words, i + 1);
        }
        return null;
    }

    private static string? ChangedDir(List<string> words, string? cwd)
    {
        var at = CommandStart(words);
        if (WordAt(words, at) != "cd")
            return cwd;
        var target = WordAt(words, at + 1);
        if (string.IsNullOrEmpty(target) || target == "-" || target.StartsWith('~'))
            return null;
        if (Path.IsPathRooted(target))
            return target;
        return cwd is null ? null : ResolvePath(cwd, target);
    }

    public static string ResolvePath(string cwd, string path)
    {
        var full = Path.GetFullPath(path, Path.GetFullPath(cwd));
        var root = Path.GetPathRoot(full);
        return full.Length > (root?.Length ?? 1) ? full.TrimEnd(Path.DirectorySeparatorChar) : full;
    }
}

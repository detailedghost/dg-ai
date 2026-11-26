using Dg.Hooks.Shared;
using System.Text;
using System.Text.RegularExpressions;

namespace Dg.Hooks.Defs.Pr;

internal static partial class PrBodyExtractor
{
    private readonly record struct Heredoc(bool Flagged, string Text);

    private readonly record struct Pending(bool Flagged, string Delimiter);

    [GeneratedRegex(@"\G<<(?!<)-?[ \t]*['""]?(?<name>[A-Za-z_][A-Za-z0-9_]*)['""]?")]
    private static partial Regex HeredocStart();

    [GeneratedRegex(@"--body|(?:\A|[ \t])-b(?:[ \t]|\z)|(?:\A|[ \t])-F(?:[ \t]|\z)|--description|(?:\A|[ \t])-d(?:[ \t]|\z)")]
    private static partial Regex BodyFlag();

    [GeneratedRegex(@"\A\$[{(]?[A-Za-z_][A-Za-z0-9_]*[})]?\z")]
    private static partial Regex VariableOnly();

    public static string Extract(string command, string cwd)
    {
        var heredocs = CollectHeredocs(command);
        var flagged = new StringBuilder();
        var anyFlagged = false;
        foreach (var heredoc in heredocs)
            if (heredoc.Flagged)
            {
                anyFlagged = true;
                flagged.Append(heredoc.Text);
            }
        if (anyFlagged)
            return flagged.ToString();

        var tokens = PrCommandParser.ShellWords(command);
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            var next = i + 1 < tokens.Count ? tokens[i + 1] : null;
            if (token is "--body" or "-b" or "--description" or "-d")
            {
                if (next is not null && IsLiteral(next))
                    return $"{next}\n";
                continue;
            }
            if (InlineValue(token, "--body=", "--description=") is { } inline)
            {
                if (IsLiteral(inline))
                    return $"{inline}\n";
                continue;
            }
            var fileValue = token is "--body-file" or "-F" or "--description-file"
                ? next
                : InlineValue(token, "--body-file=", "--description-file=");
            if (fileValue is not null && ReadBodyFile(fileValue, cwd) is { } text)
                return text;
        }
        var all = new StringBuilder();
        foreach (var heredoc in heredocs)
            all.Append(heredoc.Text);
        return all.ToString();
    }

    private static string? InlineValue(string token, string first, string second) =>
        token.StartsWith(first, StringComparison.Ordinal) ? token[first.Length..]
        : token.StartsWith(second, StringComparison.Ordinal) ? token[second.Length..]
        : null;

    private static bool IsLiteral(string value) => value != "" && !VariableOnly().IsMatch(value);

    private static string? ReadBodyFile(string path, string cwd)
    {
        if (path is "" or "-")
            return null;
        try
        {
            var text = JsText.ReadUtf8(Path.IsPathRooted(path) ? path : PrCommandParser.ResolvePath(cwd, path));
            return text == "" ? null : text;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    private static List<Heredoc> CollectHeredocs(string command)
    {
        List<Heredoc> heredocs = [];
        List<Pending> pending = [];
        Stack<char> outer = [];
        var quote = '\0';
        var lineStart = 0;
        for (var i = 0; i < command.Length; i++)
        {
            var c = command[i];
            if (quote == '"' && c == '$' && i + 1 < command.Length && command[i + 1] == '(')
            {
                outer.Push(quote);
                quote = '\0';
                i++;
                continue;
            }
            if (quote != '\0')
            {
                if (c == '\\' && quote == '"')
                    i++;
                else if (c == quote)
                    quote = '\0';
                continue;
            }
            if (c == '\\')
            {
                i++;
            }
            else if (c == ')' && outer.Count > 0)
            {
                quote = outer.Pop();
            }
            else if (c is '\'' or '"')
            {
                quote = c;
            }
            else if (c == '<')
            {
                var match = HeredocStart().Match(command, i);
                if (match.Success && (i == 0 || command[i - 1] != '<'))
                {
                    pending.Add(
                        new Pending(
                            BodyFlag().IsMatch(command.AsSpan(lineStart, i - lineStart)),
                            match.Groups["name"].Value
                        )
                    );
                    i += match.Length - 1;
                }
            }
            else if (c == '\n')
            {
                foreach (var heredoc in pending)
                {
                    var text = new StringBuilder();
                    var at = i + 1;
                    while (at < command.Length)
                    {
                        var nl = command.IndexOf('\n', at);
                        var line = JsText.Slice(command, at, nl < 0 ? command.Length : nl);
                        at = nl < 0 ? command.Length : nl + 1;
                        if (JsText.Trim(line) == heredoc.Delimiter)
                            break;
                        text.Append(line).Append('\n');
                    }
                    heredocs.Add(new Heredoc(heredoc.Flagged, text.ToString()));
                    i = at - 1;
                }
                pending.Clear();
                lineStart = i + 1;
            }
        }
        return heredocs;
    }
}

namespace Dg.Completion;

internal static class Completer
{
    public const string FilesDirective = ":files";

    private static readonly CompletionOption Help = new(
        ["--help"],
        "show help",
        ValueKind.None,
        null,
        null
    );

    public static List<string> Complete(CompletionNode root, ReadOnlySpan<string> words)
    {
        var current = words.Length == 0 ? "" : words[^1];
        var stack = new List<CompletionNode> { root };
        CompletionOption? pending = null;
        var positional = false;
        var literal = false;
        var consumed = 0;
        for (var i = 0; i < words.Length - 1; i++)
        {
            var word = words[i];
            var node = stack[^1];
            if (pending is not null)
            {
                pending = null;
                continue;
            }

            if (!literal && word == "--")
            {
                literal = true;
                continue;
            }

            if (!literal && word.StartsWith('-') && word.Length > 1)
            {
                var eq = word.IndexOf('=');
                var flag = eq < 0 ? word : word[..eq];
                var option = FindOption(stack, flag);
                if (option?.Mode is not null)
                {
                    stack.Add(option.Mode);
                }
                else if (option is { Kind: not ValueKind.None } && eq < 0)
                {
                    pending = option;
                }

                continue;
            }

            var child = positional || literal ? null : FindCommand(node, word);
            if (child is not null)
            {
                stack.Add(child);
                consumed = 0;
            }
            else
            {
                positional = true;
                consumed++;
            }
        }

        var last = stack[^1];
        if (pending is not null)
        {
            return ValueCandidates(pending, current, "");
        }

        if (!literal && current.StartsWith('-'))
        {
            var eq = current.IndexOf('=');
            if (eq > 0)
            {
                var option = FindOption(stack, current[..eq]);
                return option is { Kind: not ValueKind.None }
                    ? ValueCandidates(option, current[(eq + 1)..], current[..(eq + 1)])
                    : [];
            }

            return OptionCandidates(stack, current);
        }

        if (!positional && !literal && last.Commands is { Length: > 0 } commands)
        {
            var matches = new List<string>();
            foreach (var command in commands)
            {
                if (command.Name.StartsWith(current, StringComparison.Ordinal))
                {
                    matches.Add(Candidate(command.Name, command.Description));
                }
            }

            return matches;
        }

        if (last.Values is not null && consumed == 0)
        {
            var matches = new List<string>();
            foreach (var value in last.Values)
            {
                if (value.StartsWith(current, StringComparison.Ordinal))
                {
                    matches.Add(value);
                }
            }

            return matches;
        }

        return last.Path ? [FilesDirective] : [];
    }

    private static string Candidate(string value, string? description) =>
        string.IsNullOrEmpty(description) ? value : $"{value}\t{description}";

    private static CompletionNode? FindCommand(CompletionNode node, string word)
    {
        if (node.Commands is null)
        {
            return null;
        }

        foreach (var command in node.Commands)
        {
            if (command.Name == word)
            {
                return command;
            }
        }

        return null;
    }

    private static CompletionOption? FindOption(List<CompletionNode> stack, string flag)
    {
        for (var i = stack.Count - 1; i >= 0; i--)
        {
            if (stack[i].Options is not { } options)
            {
                continue;
            }

            foreach (var option in options)
            {
                if (Array.IndexOf(option.Flags, flag) >= 0)
                {
                    return option;
                }
            }
        }

        return null;
    }

    private static List<string> ValueCandidates(
        CompletionOption option,
        string current,
        string prefix
    )
    {
        if (option.Kind == ValueKind.Path)
        {
            return [FilesDirective];
        }

        var matches = new List<string>();
        if (option.Choices is null)
        {
            return matches;
        }

        foreach (var choice in option.Choices)
        {
            if (choice.StartsWith(current, StringComparison.Ordinal))
            {
                matches.Add(prefix + choice);
            }
        }

        return matches;
    }

    private static List<string> OptionCandidates(List<CompletionNode> stack, string current)
    {
        var matches = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = stack.Count - 1; i >= 0; i--)
        {
            if (stack[i].Options is { } options)
            {
                foreach (var option in options)
                {
                    AddOption(option, current, seen, matches);
                }
            }
        }

        AddOption(Help, current, seen, matches);
        return matches;
    }

    private static void AddOption(
        CompletionOption option,
        string current,
        HashSet<string> seen,
        List<string> matches
    )
    {
        foreach (var flag in option.Flags)
        {
            if (
                !flag.StartsWith("--", StringComparison.Ordinal)
                || !flag.StartsWith(current, StringComparison.Ordinal)
            )
            {
                continue;
            }

            if (seen.Add(flag))
            {
                matches.Add(Candidate(flag, option.Description));
            }

            return;
        }
    }
}

using System.Text.RegularExpressions;

namespace Dg.Hooks.Defs.Text;

internal static partial class MarkdownSkip
{
    [GeneratedRegex(
        @"(^|/)(\.claude|\.agents|CLAUDE\.md|AGENTS\.md|MEMORY\.md|SKILL\.md)(/|$)|\.opencode/agents/|-(spec|plan|refactor)\.md\z|(^|/)refactor-[^/]*\.md\z",
        RegexOptions.CultureInvariant
    )]
    private static partial Regex Pattern();

    public static bool Matches(string normalizedPath) => Pattern().IsMatch(normalizedPath);
}

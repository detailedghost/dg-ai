using Dg.Hooks.Engine;

namespace Dg.Hooks.Defs.Text;

internal sealed class SpellingHook(TextHookIo? injected = null) : IHook
{
    private const int MaxScanChars = 512 * 1024;
    private static readonly string[] Locales = ["en-US", "en-GB"];
    private readonly HashSet<string> _warned = new(StringComparer.Ordinal);

    public string Id => "spelling";

    public ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
    {
        var io = injected ?? TextHookIo.Process();
        var runtime = new HookRuntime(io, ev, _warned);
        if (ev.ToolName is not ("Edit" or "Write" or "MultiEdit"))
            return ValueTask.FromResult(0);
        if (runtime.Bypassed("comment-disabled"))
            return ValueTask.FromResult(0);
        var text = WrittenText(ev);
        if (text.Length > MaxScanChars)
            text = text[..MaxScanChars];
        if (text.Length == 0)
            return ValueTask.FromResult(0);

        var locale = runtime.Setting("spelling", "locale", Locales);
        var found = Findings(
            text,
            SpellingTable.For(locale),
            runtime.Number("HOOK_SPELLING_MAX_FINDINGS", 8)
        );
        if (found.Count == 0)
            return ValueTask.FromResult(0);
        io.Err.Write(
            $"spelling: write {locale} in {ev.FilePath ?? ""}\n{string.Join('\n', found)}\nfix: use the {locale} spelling in code, identifiers, tests, comments and docs.\n"
        );
        return ValueTask.FromResult(2);
    }

    internal static List<string> Findings(ReadOnlySpan<char> text, SpellingTable table, double max)
    {
        List<string> found = [];
        HashSet<string> seen = new(StringComparer.Ordinal);
        var lineNumber = 0;
        var start = 0;
        while (start <= text.Length)
        {
            var rest = text[start..];
            var newline = rest.IndexOf('\n');
            var line = newline < 0 ? rest : rest[..newline];
            lineNumber++;
            var i = 0;
            while (i < line.Length)
            {
                while (i < line.Length && !IsAsciiLetter(line[i]))
                    i++;
                if (i == line.Length)
                    break;
                var tokenStart = i++;
                while (i < line.Length && IsAsciiLetter(line[i]) && !IsCaseBoundary(line[i - 1], line[i]))
                    i++;
                var token = line[tokenStart..i];
                if (table.TryFind(token, out var fix))
                {
                    var entry = $"{lineNumber}: {token} -> {fix}";
                    if (seen.Add(entry))
                        found.Add(entry);
                }
                if (found.Count >= max)
                    return found;
            }
            if (newline < 0)
                break;
            start += newline + 1;
        }
        return found;
    }

    private static string WrittenText(HookEvent ev) =>
        ev.ToolName switch
        {
            "Write" => ev.Content ?? "",
            "MultiEdit" => string.Join('\n', ev.Edits),
            _ => ev.NewString ?? "",
        };

    private static bool IsAsciiLetter(char c) => c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z');

    private static bool IsCaseBoundary(char previous, char current) =>
        previous is >= 'a' and <= 'z' && current is >= 'A' and <= 'Z';
}

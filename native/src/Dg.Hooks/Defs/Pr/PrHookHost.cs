namespace Dg.Hooks.Defs.Pr;

internal sealed class PrHookHost(
    IReadOnlyDictionary<string, string?>? env = null,
    TextWriter? output = null,
    TextWriter? error = null
)
{
    private IReadOnlyDictionary<string, string?>? _env = env;
    private TextWriter? _output = output;
    private TextWriter? _error = error;

    public IReadOnlyDictionary<string, string?> Env => _env ??= Snapshot();

    public TextWriter Output => _output ??= Console.Out;

    public TextWriter Error => _error ??= Console.Error;

    public string SessionOf(string? fromInput) =>
        Sanitize(
            First("CLAUDE_CODE_SESSION_ID")
                ?? First("CLAUDE_SESSION_ID")
                ?? First("CODEX_THREAD_ID")
                ?? (string.IsNullOrEmpty(fromInput) ? null : fromInput)
                ?? "NOSESSION"
        );

    public string MarkerSession() =>
        Sanitize(First("CLAUDE_CODE_SESSION_ID") ?? First("CLAUDE_SESSION_ID") ?? "NOSESSION");

    public string? Value(string name) => Env.TryGetValue(name, out var value) ? value : null;

    private string? First(string name) => Value(name) is { Length: > 0 } value ? value : null;

    private static string Sanitize(string raw)
    {
        var chars = raw.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
            if (!char.IsAsciiLetterOrDigit(chars[i]) && chars[i] is not ('_' or '-'))
                chars[i] = '_';
        return new string(chars);
    }

    private static Dictionary<string, string?> Snapshot()
    {
        Dictionary<string, string?> copy = new(StringComparer.Ordinal);
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
            copy[(string)entry.Key] = (string?)entry.Value;
        return copy;
    }
}

using System.Collections;

namespace Dg.Hooks.Shared;

internal sealed class HookEnvironment(IReadOnlyDictionary<string, string?> values)
{
    public IReadOnlyDictionary<string, string?> Values => values;

    public static HookEnvironment Process()
    {
        Dictionary<string, string?> copy = new(StringComparer.Ordinal);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            copy[(string)entry.Key] = entry.Value as string;
        return new HookEnvironment(copy);
    }

    public string? Value(string name) => values.TryGetValue(name, out var value) ? value : null;

    public string? First(string name) => Value(name) is { Length: > 0 } value ? value : null;

    public double Number(string name, double fallback) => JsText.FiniteOr(First(name), fallback);

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

    private static string Sanitize(string raw)
    {
        Span<char> buffer = raw.Length <= 128 ? stackalloc char[raw.Length] : new char[raw.Length];
        for (var i = 0; i < raw.Length; i++)
        {
            var c = raw[i];
            buffer[i] = char.IsAsciiLetterOrDigit(c) || c is '_' or '-' ? c : '_';
        }
        return new string(buffer);
    }
}

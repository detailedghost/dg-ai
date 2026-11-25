using System.Collections.Frozen;
using System.Text.RegularExpressions;

namespace Dg.Core.Config;

public static partial class ConfigRules
{
    private static readonly KeyValuePair<string, object>[] Entries =
    [
        new("browser.mode", "auto"),
        new("front.enabled", true),
        new("install.cli_only", false),
        new("ssms.allow_send", false),
        new("ssms.google.send_enabled", false),
    ];

    public static FrozenDictionary<string, object> Defaults { get; } = Entries.ToFrozenDictionary(StringComparer.Ordinal);

    public static string[] DefaultKeys { get; } = KeysOf(Entries);

    private static readonly string[] SecretFields = ["inbox.gmail.clientSecret", "inbox.outlook.clientSecret"];

    private static readonly string[] UnsafeParts = ["__proto__", "constructor", "prototype"];

    [GeneratedRegex(
        @"(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex SecretKeyName();

    private static string[] KeysOf(KeyValuePair<string, object>[] entries)
    {
        var keys = new string[entries.Length];
        for (var i = 0; i < keys.Length; i++)
            keys[i] = entries[i].Key;
        return keys;
    }

    public static bool IsUnsafePart(ReadOnlySpan<char> part)
    {
        foreach (var unsafePart in UnsafeParts)
            if (part.SequenceEqual(unsafePart))
                return true;
        return false;
    }

    public static bool IsSecretField(string key) => Array.IndexOf(SecretFields, key) >= 0;

    public static bool IsInvalid(string key)
    {
        var span = key.AsSpan();
        foreach (var range in span.Split('.'))
        {
            var part = span[range];
            if (part.IsEmpty || IsUnsafePart(part))
                return true;
        }
        return false;
    }

    public static bool IsPluginSetting(string key) => TryPluginSettingTail(key, out _);

    public static bool IsSecretKey(string key)
    {
        if (IsSecretField(key))
            return true;
        return TryPluginSettingTail(key, out var tail) && SecretKeyName().IsMatch(tail[(tail.LastIndexOf('.') + 1)..]);
    }

    private static bool TryPluginSettingTail(string key, out ReadOnlySpan<char> tail)
    {
        tail = default;
        var rest = key.AsSpan();
        if (!rest.StartsWith("plugins.", StringComparison.Ordinal))
            return false;
        rest = rest["plugins.".Length..];
        var name = rest.IndexOf('.');
        if (name < 0)
            return false;
        rest = rest[(name + 1)..];
        var section = rest.IndexOf('.');
        if (!(section < 0 ? rest : rest[..section]).SequenceEqual("settings"))
            return false;
        tail = section < 0 ? default : rest[(section + 1)..];
        return true;
    }
}

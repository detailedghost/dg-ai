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

    public static bool IsUnsafePart(string part) => Array.IndexOf(UnsafeParts, part) >= 0;

    public static bool IsSecretField(string key) => Array.IndexOf(SecretFields, key) >= 0;

    public static bool IsInvalid(string key)
    {
        foreach (var part in key.Split('.'))
            if (part.Length == 0 || IsUnsafePart(part))
                return true;
        return false;
    }

    public static bool IsSecretKey(string key)
    {
        if (IsSecretField(key))
            return true;
        var parts = key.Split('.');
        return parts[0] == "plugins"
            && parts.Length > 3
            && parts[2] == "settings"
            && SecretKeyName().IsMatch(parts[^1]);
    }
}

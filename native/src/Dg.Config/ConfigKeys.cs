using System.Collections.Frozen;
using System.Text.RegularExpressions;

namespace Dg.Config;

internal readonly record struct KnownKey(bool Text, object? Fallback);

internal enum KeyKind
{
    Unknown,
    Known,
    Hook,
}

internal static partial class ConfigKeys
{
    private static readonly FrozenDictionary<string, object> Defaults = new Dictionary<string, object>
    {
        ["browser.mode"] = "auto",
        ["front.enabled"] = true,
        ["install.cli_only"] = false,
        ["ssms.allow_send"] = false,
        ["ssms.google.send_enabled"] = false,
    }.ToFrozenDictionary(StringComparer.Ordinal);

    private static readonly string[] SendSwitches = ["ssms.allow_send", "ssms.google.send_enabled"];

    private static readonly string[] UnsafeParts = ["__proto__", "constructor", "prototype"];

    private static readonly string[] SecretFields = ["inbox.gmail.clientSecret", "inbox.outlook.clientSecret"];

    [GeneratedRegex(
        @"(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
    )]
    private static partial Regex SecretKeyName();

    public static string[] DefaultKeys { get; } = ["browser.mode", "front.enabled", "install.cli_only", "ssms.allow_send", "ssms.google.send_enabled"];

    public static object? DefaultOf(string key) => Defaults.GetValueOrDefault(key);

    public static KeyKind Classify(string key, out KnownKey known)
    {
        known = default;
        if (Defaults.TryGetValue(key, out var fallback))
        {
            known = new KnownKey(false, fallback);
            return KeyKind.Known;
        }
        var parts = key.Split('.');
        var section = parts[0];
        var name = parts.Length > 1 ? parts[1] : "";
        var field = parts.Length > 2 ? parts[2] : "";
        var hasRest = parts.Length > 3;
        if (section == "hooks" && parts.Length == 3)
            return KeyKind.Hook;
        if (key == "refs.default_repo" || (section == "refs" && name == "aliases" && parts.Length == 3))
            return Known(true, null, out known);
        if (section is "inbox" or "ssms" && parts.Length >= 2)
            return Known(false, null, out known);
        if (section == "plugins" && parts.Length == 3 && field == "enabled")
            return Known(false, true, out known);
        if (section == "plugins" && parts.Length == 3 && field == "source")
            return Known(true, null, out known);
        if (section == "plugins" && field == "settings" && hasRest)
            return Known(false, null, out known);
        return KeyKind.Unknown;
    }

    public static bool TurnsSendingOn(string key)
    {
        foreach (var name in SendSwitches)
            if (name == key || name.StartsWith(key + ".", StringComparison.Ordinal))
                return true;
        return false;
    }

    public static bool IsInvalid(string key)
    {
        foreach (var part in key.Split('.'))
            if (part.Length == 0 || Array.IndexOf(UnsafeParts, part) >= 0)
                return true;
        return false;
    }

    public static bool IsSecretKey(string key)
    {
        if (Array.IndexOf(SecretFields, key) >= 0)
            return true;
        var parts = key.Split('.');
        return parts[0] == "plugins" && parts.Length > 3 && parts[2] == "settings" && SecretKeyName().IsMatch(parts[^1]);
    }

    private static KeyKind Known(bool text, object? fallback, out KnownKey known)
    {
        known = new KnownKey(text, fallback);
        return KeyKind.Known;
    }
}

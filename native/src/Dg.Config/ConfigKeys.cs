using Dg.Core.Config;

namespace Dg.Config;

internal readonly record struct KnownKey(bool Text, object? Fallback);

internal enum KeyKind
{
    Unknown,
    Known,
    Hook,
}

internal static class ConfigKeys
{
    private static readonly string[] SendSwitches = ["ssms.allow_send", "ssms.google.send_enabled"];

    public static object? DefaultOf(string key) => ConfigRules.Defaults.GetValueOrDefault(key);

    public static KeyKind Classify(string key, out KnownKey known)
    {
        known = default;
        if (ConfigRules.Defaults.TryGetValue(key, out var fallback))
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
        if (section == "plugins" && parts.Length == 3 && field == "fail_closed")
            return Known(false, false, out known);
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

    private static KeyKind Known(bool text, object? fallback, out KnownKey known)
    {
        known = new KnownKey(text, fallback);
        return KeyKind.Known;
    }
}

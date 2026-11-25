using System.Collections.Frozen;
using Dg.Core.Errors;
using Tomlyn.Model;

namespace Dg.Core.Config;

public sealed class DgSettings(DgToml toml, IReadOnlyDictionary<string, string?> env)
{
    private static readonly FrozenDictionary<string, object> Defaults = new Dictionary<string, object>
    {
        ["browser.mode"] = "auto",
        ["front.enabled"] = true,
        ["install.cli_only"] = false,
        ["ssms.allow_send"] = false,
        ["ssms.google.send_enabled"] = false,
    }.ToFrozenDictionary();

    public ConfigResult<bool> Bool(string key, bool? flag = null, string? envVar = null)
    {
        if (flag is { } given)
            return ConfigResult<bool>.Ok(given);
        if (CheckKey(key) is { } error)
            return ConfigResult<bool>.Fail(error);
        if (envVar is not null && env.TryGetValue(envVar, out var raw) && raw is not null)
            return ParseBool(envVar, raw);
        return ConfigResult<bool>.Ok(
            (Lookup(key) ?? Defaults.GetValueOrDefault(key)) is true
        );
    }

    public ConfigResult<string?> String(string key, string? flag = null, string? envVar = null)
    {
        if (flag is not null)
            return ConfigResult<string?>.Ok(flag);
        if (CheckKey(key) is { } error)
            return ConfigResult<string?>.Fail(error);
        if (envVar is not null && env.TryGetValue(envVar, out var raw) && raw is not null)
            return ConfigResult<string?>.Ok(raw);
        return ConfigResult<string?>.Ok(
            (Lookup(key) ?? Defaults.GetValueOrDefault(key)) as string
        );
    }

    private static ConfigResult<bool> ParseBool(string name, string raw)
    {
        if (raw.Equals("1", StringComparison.Ordinal) || IsAny(raw, "true", "yes", "on"))
            return ConfigResult<bool>.Ok(true);
        if (raw.Equals("0", StringComparison.Ordinal) || IsAny(raw, "false", "no", "off"))
            return ConfigResult<bool>.Ok(false);
        return ConfigResult<bool>.Fail(
            new DgError(
                "",
                null,
                name,
                $"{name} must be true or false (or 1, 0, yes, no, on, off).",
                $"fix or unset {name}."
            )
        );
    }

    private static bool IsAny(string raw, params string[] names)
    {
        foreach (var name in names)
            if (raw.Equals(name, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }

    private static DgError? CheckKey(string key)
    {
        foreach (var part in key.Split('.'))
            if (part.Length == 0 || part is "__proto__" or "constructor" or "prototype")
                return new DgError(
                    "",
                    null,
                    key,
                    $"{key} is not a valid key.",
                    "use dotted names such as install.cli_only."
                );
        return null;
    }

    private object? Lookup(string key)
    {
        var parts = key.Split('.');
        return parts switch
        {
            ["browser", "mode"] => toml.BrowserMode.Wire(),
            ["front", "enabled"] => toml.FrontEnabled,
            ["install", "cli_only"] => toml.InstallCliOnly,
            ["refs", "default_repo"] => toml.RefsDefaultRepo,
            ["inbox", .. var rest] => Walk(toml.Inbox, rest),
            ["ssms", .. var rest] => Walk(toml.Ssms, rest),
            ["plugins", var name, .. var rest] when toml.Plugins.TryGetValue(name, out var plugin) =>
                rest switch
                {
                    ["enabled"] => plugin.Enabled,
                    ["allow_remote"] => plugin.AllowRemote,
                    ["source"] => plugin.Source,
                    ["settings", .. var path] => Walk(plugin.Settings, path),
                    _ => null,
                },
            _ => null,
        };
    }

    private static object? Walk(TomlTable table, string[] path)
    {
        object? node = table;
        foreach (var part in path)
        {
            if (node is not TomlTable current || !current.TryGetValue(part, out node))
                return null;
        }
        return node;
    }
}

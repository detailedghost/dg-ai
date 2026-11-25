using Dg.Core.Config;
using Dg.Core.Credentials;
using Tomlyn.Model;

namespace Dg.Config;

internal static class ConfigValues
{
    public static object? Lookup(DgToml toml, string key)
    {
        var parts = key.Split('.');
        return parts switch
        {
            ["browser", "mode"] => toml.BrowserMode.Wire(),
            ["front", "enabled"] => toml.FrontEnabled,
            ["install", "cli_only"] => toml.InstallCliOnly,
            ["refs", "default_repo"] => toml.RefsDefaultRepo,
            ["refs", "aliases", var alias] => toml.RefsAliases.GetValueOrDefault(alias),
            ["inbox", .. var rest] => Walk(toml.Inbox, rest),
            ["ssms", .. var rest] => Walk(toml.Ssms, rest),
            ["plugins", var name, .. var rest] when toml.Plugins.TryGetValue(name, out var plugin) =>
                rest switch
                {
                    ["enabled"] => plugin.Enabled,
                    ["source"] => plugin.Source,
                    ["settings", .. var path] => Walk(plugin.Settings, path),
                    _ => null,
                },
            _ => null,
        };
    }

    public static string Shown(object? value) =>
        value switch
        {
            null => "",
            string text => text,
            _ when SecretRef.TryRead(value, out var reference) => $"{{ credential = \"{reference.Credential}\" }}",
            TomlTable table => TomlWriter.Stringify(table).TrimEnd(),
            bool flag => flag ? "true" : "false",
            _ => TomlJson.Stringify(value),
        };

    private static object? Walk(TomlTable table, string[] path)
    {
        object? node = table;
        foreach (var part in path)
            if (node is not TomlTable current || !current.TryGetValue(part, out node))
                return null;
        return node;
    }
}

using System.Collections;
using System.Text.RegularExpressions;
using Dg.Core.Credentials;
using Dg.Core.Errors;
using Tomlyn.Model;

namespace Dg.Core.Config;

internal static partial class DgTomlValidator
{
    private const string NextEdit = "run dg config edit, or dg config set";

    private static readonly string[] Sections =
    [
        "pw",
        "front",
        "hooks",
        "install",
        "refs",
        "inbox",
        "ssms",
        "plugins",
        "meta",
    ];

    [GeneratedRegex(
        @"^(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-|glpat-|AKIA|ASIA|AIza|ya29\.)|^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{32,}={0,2}\z"
    )]
    private static partial Regex TokenLike();

    [GeneratedRegex(@"^https?://[a-z0-9.:\[\]-]+\z")]
    private static partial Regex SiteKey();

    public static DgToml Validate(TomlTable root, string file, string text)
    {
        var where = new Where(file, text);
        RejectRetiredBrowser(where, Get(root, "browser"));
        foreach (var name in root.Keys)
            if (Array.IndexOf(Sections, name) < 0)
                throw Fail(where, name, $"{name} is not a dg config section.", $"{NextEdit} <section>.<key> <value>.");
        foreach (var (name, value) in root)
        {
            CheckStrings(where, name, value);
            CheckSecrets(where, name, value);
        }
        var pw = Table(where, "pw", Get(root, "pw"));
        OnlyKeys(where, "pw", pw, ["mode", "phi_sites"]);
        var front = Table(where, "front", Get(root, "front"));
        OnlyKeys(where, "front", front, ["enabled"]);
        var hooksTable = Table(where, "hooks", Get(root, "hooks"));
        Dictionary<string, IReadOnlyDictionary<string, string>> hooks = [];
        foreach (var (id, value) in hooksTable)
            hooks[id] = StringTable(where, $"hooks.{id}", value);
        var install = Table(where, "install", Get(root, "install"));
        OnlyKeys(where, "install", install, ["cli_only"]);
        var refs = Table(where, "refs", Get(root, "refs"));
        OnlyKeys(where, "refs", refs, ["default_repo", "aliases"]);
        var defaultRepo = OptionalString(where, "refs.default_repo", Get(refs, "default_repo"));
        var ssms = Table(where, "ssms", Get(root, "ssms"));
        OptionalBoolean(where, "ssms.allow_send", Get(ssms, "allow_send"), false);
        OptionalBoolean(
            where,
            "ssms.google.send_enabled",
            Get(Table(where, "ssms.google", Get(ssms, "google")), "send_enabled"),
            false
        );
        Dictionary<string, PluginEntry> plugins = [];
        foreach (var (name, value) in Table(where, "plugins", Get(root, "plugins")))
            plugins[name] = Plugin(where, $"plugins.{name}", value);
        var meta = Table(where, "meta", Get(root, "meta"));
        OnlyKeys(where, "meta", meta, ["migrated"]);
        return new DgToml(
            ParsePwMode(where, "pw.mode", Get(pw, "mode")),
            SiteKeys(where, "pw.phi_sites", Get(pw, "phi_sites")),
            OptionalBoolean(where, "front.enabled", Get(front, "enabled"), true),
            hooks,
            OptionalBoolean(where, "install.cli_only", Get(install, "cli_only"), false),
            defaultRepo,
            StringTable(where, "refs.aliases", Get(refs, "aliases")),
            Table(where, "inbox", Get(root, "inbox")),
            ssms,
            plugins,
            StringTable(where, "meta.migrated", Get(meta, "migrated"))
        );
    }

    private readonly record struct Where(string File, string Text);

    private static object? Get(TomlTable table, string name) =>
        table.TryGetValue(name, out var value) ? value : null;

    private static DgException Fail(Where where, string key, string message, string next) =>
        new DgError(where.File, ConfigLines.LineOfKey(where.Text, key), key, message, next).ToException();

    private static DgException MustBe(Where where, string key, string type, object? value) =>
        Fail(
            where,
            key,
            $"{key} must be {type}, got {Shown(value)}.",
            $"{NextEdit} {key} <value>."
        );

    private static DgException MustBeSecretRef(Where where, string key) =>
        Fail(
            where,
            key,
            $"{key} must be a credential reference {{ credential = \"<name>\" }}, got a plain value.",
            $"store the value with dg credentials set <name>, then run dg config set {key} --credential <name>."
        );

    private static string Shown(object? value)
    {
        var text = TomlJson.Stringify(value);
        return text.Length > 60 ? $"{text[..57]}..." : text;
    }

    private static void CheckStrings(Where where, string key, object? value)
    {
        switch (value)
        {
            case string text:
                if (text.Contains("{{resolve:", StringComparison.Ordinal))
                    throw Fail(
                        where,
                        key,
                        $"{key} must not hold a {{{{resolve:...}}}} placeholder.",
                        $"{NextEdit} {key} <value>."
                    );
                break;
            case TomlTable table:
                foreach (var (name, item) in table)
                {
                    if (ConfigRules.IsUnsafePart(name))
                        throw Fail(
                            where,
                            $"{key}.{name}",
                            $"{key}.{name} is not an allowed key.",
                            $"{NextEdit} {key} <value>."
                        );
                    CheckStrings(where, $"{key}.{name}", item);
                }
                break;
            case IEnumerable items:
                var index = 0;
                foreach (var item in items)
                    CheckStrings(where, $"{key}.{index++}", item);
                break;
        }
    }

    private static void CheckSecrets(Where where, string key, object? value)
    {
        if (SecretRef.TryRead(value, out _))
            return;
        var refused = ConfigRules.IsSecretField(key) || value is string or TomlTable or IEnumerable;
        if (ConfigRules.IsSecretKey(key) && refused)
            throw MustBeSecretRef(where, key);
        switch (value)
        {
            case TomlTable table:
                foreach (var (name, item) in table)
                    CheckSecrets(where, $"{key}.{name}", item);
                return;
            case string text when ConfigRules.IsPluginSetting(key) && TokenLike().IsMatch(text):
                throw MustBeSecretRef(where, key);
            case string:
                return;
            case IEnumerable items:
                var index = 0;
                foreach (var item in items)
                    CheckSecrets(where, $"{key}.{index++}", item);
                return;
        }
    }

    private static TomlTable Table(Where where, string key, object? value)
    {
        if (value is null)
            return new TomlTable();
        return value as TomlTable ?? throw MustBe(where, key, "a table", value);
    }

    private static Dictionary<string, string> StringTable(Where where, string key, object? value)
    {
        Dictionary<string, string> result = [];
        foreach (var (name, item) in Table(where, key, value))
        {
            if (item is not string text)
            {
                throw MustBe(where, $"{key}.{name}", "a string", item);
            }
            result[name] = text;
        }
        return result;
    }

    private static bool OptionalBoolean(Where where, string key, object? value, bool fallback)
    {
        if (value is null)
            return fallback;
        return value as bool? ?? throw MustBe(where, key, "a boolean", value);
    }

    private static string? OptionalString(Where where, string key, object? value)
    {
        if (value is null)
            return null;
        return value as string ?? throw MustBe(where, key, "a string", value);
    }

    private static PwMode ParsePwMode(Where where, string key, object? value)
    {
        switch (value)
        {
            case null:
                return PwMode.Auto;
            case "ext":
                return PwMode.Ext;
            case "local":
                return PwMode.Local;
            case "auto":
                return PwMode.Auto;
            default:
                throw MustBe(where, key, "ext, local or auto", value);
        }
    }

    private static List<string> SiteKeys(Where where, string key, object? value)
    {
        List<string> sites = [];
        if (value is null)
            return sites;
        if (value is not IEnumerable items || value is string or TomlTable)
            throw MustBe(where, key, "a list of site keys such as \"https://example.org\"", value);
        var index = 0;
        foreach (var item in items)
        {
            if (item is not string text || !SiteKey().IsMatch(text))
                throw MustBe(where, $"{key}.{index}", "a site key such as \"https://example.org\"", item);
            sites.Add(text);
            index++;
        }
        return sites;
    }

    private static void RejectRetiredBrowser(Where where, object? value)
    {
        if (value is null)
            return;
        var key = value is TomlTable table && table.ContainsKey("mode") ? "browser.mode" : "browser";
        throw Fail(where, key, $"{key} moved to pw.mode.", $"{NextEdit} pw.mode <value>.");
    }

    private static void OnlyKeys(Where where, string key, TomlTable value, ReadOnlySpan<string> allowed)
    {
        foreach (var name in value.Keys)
            if (!allowed.Contains(name))
                throw Fail(
                    where,
                    $"{key}.{name}",
                    $"{key}.{name} is not a dg config key.",
                    $"{NextEdit} {key}.<key> <value>."
                );
    }

    private static PluginEntry Plugin(Where where, string key, object? value)
    {
        if (key.Split('.').Length != 2)
            throw Fail(
                where,
                key,
                $"{key} is not a valid plugin name; a plugin name has no dot.",
                $"{NextEdit} plugins.<name>.enabled <value>."
            );
        var entry = Table(where, key, value);
        OnlyKeys(where, key, entry, ["enabled", "allow_remote", "fail_closed", "source", "settings"]);
        var source = OptionalString(where, $"{key}.source", Get(entry, "source"));
        return new PluginEntry(
            OptionalBoolean(where, $"{key}.enabled", Get(entry, "enabled"), true),
            OptionalBoolean(where, $"{key}.allow_remote", Get(entry, "allow_remote"), false),
            OptionalBoolean(where, $"{key}.fail_closed", Get(entry, "fail_closed"), false),
            source,
            Table(where, $"{key}.settings", Get(entry, "settings"))
        );
    }
}

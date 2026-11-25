using System.Globalization;
using System.Text.RegularExpressions;
using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Tomlyn;
using Tomlyn.Model;

namespace Dg.Core.Plugins.Manifest;

public static partial class ManifestParser
{
    private static readonly string[] RootKeys =
    [
        "name",
        "version",
        "kind",
        "transport",
        "endpoint",
        "remote",
        "source",
        "sha256",
        "commit",
        "entry",
        "capabilities",
        "permissions",
    ];
    private static readonly string[] Kinds = ["hook", "job", "skill"];
    private static readonly string[] Transports = ["ipc", "http", "tcp", "udp"];
    private static readonly string[] LoopbackHosts = ["127.0.0.1", "localhost", "::1", "[::1]"];

    [GeneratedRegex(@"^[a-z][a-z0-9-]{0,63}\z")]
    private static partial Regex NamePattern();

    [GeneratedRegex(@"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\z")]
    private static partial Regex SemverPattern();

    [GeneratedRegex(@"^[0-9a-f]{64}\z")]
    private static partial Regex Sha256Pattern();

    [GeneratedRegex(@"^(?:[0-9a-f]{40}|[0-9a-f]{64})\z")]
    private static partial Regex CommitPattern();

    [GeneratedRegex(@"^(\[[^\]]+\]|[^:\s/]+):([0-9]{1,5})\z")]
    private static partial Regex HostPortPattern();

    [GeneratedRegex(@"^[a-z0-9][a-z0-9._/-]{0,127}\z")]
    private static partial Regex CredentialPattern();

    public static PluginManifest Parse(string text, string file)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(file);
        TomlTable raw;
        try
        {
            raw = TomlSerializer.Deserialize(text, ManifestTomlContext.Default.TomlTable) ?? [];
        }
        catch (TomlException error)
        {
            var reason = error.Diagnostics is { Count: > 0 } diagnostics ? diagnostics[0].Message : error.Message;
            var line = error.Line > 0 ? error.Line : 1;
            throw new PluginContractException(
                "manifest",
                $"dg plugin: {file}:{line}: plugin.toml is not valid TOML: {reason.Split('\n')[0]}. Next: fix the line, then run dg plugin verify."
            );
        }
        return new Reader(file, text).Read(raw);
    }

    private sealed class Reader(string file, string text)
    {
        public PluginManifest Read(TomlTable root)
        {
            OnlyKeys("", root, RootKeys);
            var name = RequiredString("name", Get(root, "name"));
            if (!NamePattern().IsMatch(name))
                throw Fail("name", "name must be lowercase letters, digits and hyphens, starting with a letter");
            var version = RequiredString("version", Get(root, "version"));
            if (!SemverPattern().IsMatch(version))
                throw Fail("version", $"version must be a semantic version like 1.2.3, got {version}");
            var kindText = OneOf("kind", Get(root, "kind"), Kinds);
            var entry = ReadEntry(Get(root, "entry"));
            var transportText = OneOf("transport", Get(root, "transport"), Transports, "ipc");
            var endpoint = OptionalString("endpoint", Get(root, "endpoint"));
            var remoteRaw = Get(root, "remote");
            if (remoteRaw is not null and not bool)
                throw Fail("remote", "remote must be true or false");
            var remote = remoteRaw is true;
            var transport = Enum.Parse<PluginTransportKind>(transportText, ignoreCase: true);
            if (entry.IsBuiltin)
            {
                if (endpoint is not null)
                    throw Fail("endpoint", "a built-in plugin runs in process and takes no endpoint");
                if (remote)
                    throw Fail("remote", "a built-in plugin cannot be remote");
            }
            else
                CheckEndpoint(transport, transportText, remote, endpoint);
            var kind = Enum.Parse<PluginKind>(kindText, ignoreCase: true);
            var source = OptionalString("source", Get(root, "source"));
            var pin = ReadPin(root, kind, source);
            var capabilities = Table("capabilities", Get(root, "capabilities"));
            OnlyKeys("capabilities", capabilities, ["network", "fs_read", "fs_write", "exec"]);
            var network = Get(capabilities, "network");
            if (network is not null and not bool)
                throw Fail("capabilities.network", "capabilities.network must be true or false");
            var permissions = Table("permissions", Get(root, "permissions"));
            OnlyKeys("permissions", permissions, ["credentials", "env"]);
            var credentials = StringList("permissions.credentials", Get(permissions, "credentials"));
            foreach (var credential in credentials)
                if (!CredentialPattern().IsMatch(credential))
                    throw Fail("permissions.credentials", $"{credential} is not a valid credential name");
            return new(
                name,
                version,
                kind,
                transport,
                endpoint,
                remote,
                source,
                pin,
                entry,
                new(
                    network is true,
                    StringList("capabilities.fs_read", Get(capabilities, "fs_read")),
                    StringList("capabilities.fs_write", Get(capabilities, "fs_write")),
                    StringList("capabilities.exec", Get(capabilities, "exec"))
                ),
                new(credentials, StringList("permissions.env", Get(permissions, "env")))
            );
        }

        private static object? Get(TomlTable table, string key) => table.TryGetValue(key, out var value) ? value : null;

        private PluginContractException Fail(string key, string message)
        {
            var target = key.Length == 0 ? "the file" : key;
            return new(
                "manifest",
                $"dg plugin: {file}:{TomlKeyLocator.LineOf(text, key)}: {message}. Next: fix {target} in {file}, then run dg plugin verify."
            );
        }

        private static string Shown(object? value) =>
            value switch
            {
                null => "undefined",
                string s => $"\"{s.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal)}\"",
                bool b => b ? "true" : "false",
                IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
                _ => value.ToString() ?? "",
            };

        private TomlTable Table(string key, object? value) =>
            value switch
            {
                null => [],
                TomlTable table => table,
                _ => throw Fail(key, $"{key} must be a table"),
            };

        private void OnlyKeys(string prefix, TomlTable value, string[] allowed)
        {
            foreach (var name in value.Keys)
            {
                if (Array.IndexOf(allowed, name) >= 0)
                    continue;
                var full = prefix.Length == 0 ? name : $"{prefix}.{name}";
                throw Fail(full, $"{full} is not a plugin.toml key; the keys are {string.Join(", ", allowed)}");
            }
        }

        private string? OptionalString(string key, object? value) =>
            value switch
            {
                null => null,
                string { Length: > 0 } s => s,
                _ => throw Fail(key, $"{key} must be a non-empty string"),
            };

        private string RequiredString(string key, object? value) =>
            OptionalString(key, value) ?? throw Fail(key, $"{key} is required");

        private string[] StringList(string key, object? value)
        {
            if (value is null)
                return [];
            if (value is not TomlArray array)
                throw Fail(key, $"{key} must be a list of strings");
            var items = new string[array.Count];
            for (var i = 0; i < items.Length; i++)
                items[i] = array[i] as string ?? throw Fail(key, $"{key} must be a list of strings");
            return items;
        }

        private string OneOf(string key, object? value, string[] allowed, string? fallback = null)
        {
            if (value is null && fallback is not null)
                return fallback;
            if (value is string s && Array.IndexOf(allowed, s) >= 0)
                return s;
            throw Fail(key, $"{key} must be one of {string.Join(", ", allowed)}, got {Shown(value)}");
        }

        private PluginEntry ReadEntry(object? raw)
        {
            if (raw is null)
                throw Fail("entry", "entry is required: add an [entry] table with builtin or command");
            var entry = Table("entry", raw);
            OnlyKeys("entry", entry, ["builtin", "command", "args"]);
            var builtin = OptionalString("entry.builtin", Get(entry, "builtin"));
            var command = OptionalString("entry.command", Get(entry, "command"));
            if ((builtin is null) == (command is null))
                throw Fail("entry", "entry must set exactly one of builtin or command");
            if (builtin is not null)
            {
                if (Get(entry, "args") is not null)
                    throw Fail("entry.args", "entry.args needs entry.command");
                return new(builtin, null, []);
            }
            return new(null, command, StringList("entry.args", Get(entry, "args")));
        }

        private void CheckEndpoint(PluginTransportKind transport, string transportText, bool remote, string? endpoint)
        {
            if (transport == PluginTransportKind.Ipc)
            {
                if (remote)
                    throw Fail("remote", "remote needs the http transport with an https endpoint");
                return;
            }
            if (endpoint is null)
                throw Fail("transport", $"endpoint is required for the {transportText} transport");
            if (transport == PluginTransportKind.Http)
            {
                if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var url) || url.Scheme is not ("http" or "https"))
                    throw Fail("endpoint", $"endpoint must be an http or https URL, got {endpoint}");
                if (url.UserInfo.Length > 0)
                    throw Fail(
                        "endpoint",
                        "endpoint must not hold credentials in the endpoint URL; use the plugin token from dg credentials"
                    );
                if (remote && url.Scheme != "https")
                    throw Fail("endpoint", "a remote endpoint must use https");
                if (!remote && Array.IndexOf(LoopbackHosts, url.Host) < 0)
                    throw Fail(
                        "endpoint",
                        $"endpoint host {url.Host} is not loopback; set remote = true in plugin.toml and allow_remote = true in config.toml"
                    );
                return;
            }
            if (remote)
                throw Fail("remote", "remote needs the http transport with an https endpoint");
            var match = HostPortPattern().Match(endpoint);
            if (!match.Success || !int.TryParse(match.Groups[2].ValueSpan, out var port) || port is < 1 or > 65535)
                throw Fail("endpoint", $"endpoint must be host:port for the {transportText} transport, got {endpoint}");
            var host = match.Groups[1].Value;
            if (Array.IndexOf(LoopbackHosts, host) < 0)
                throw Fail(
                    "endpoint",
                    $"endpoint host {host} is not loopback; {transportText} plugins are local only, use the http transport with remote = true"
                );
        }

        private PluginPin? ReadPin(TomlTable root, PluginKind kind, string? source)
        {
            var sha256 = OptionalString("sha256", Get(root, "sha256"));
            var commit = OptionalString("commit", Get(root, "commit"));
            if (sha256 is not null && commit is not null)
                throw Fail("commit", "set only one of sha256 or commit");
            if (sha256 is not null)
                return Sha256Pattern().IsMatch(sha256)
                    ? new(PluginPinKind.Sha256, sha256)
                    : throw Fail("sha256", "sha256 must be 64 hex characters");
            if (commit is not null)
                return CommitPattern().IsMatch(commit)
                    ? new(PluginPinKind.Commit, commit)
                    : throw Fail("commit", "commit must be 40 or 64 hex characters");
            if (kind == PluginKind.Skill || source is not null)
                throw Fail("sha256", "a skill or a plugin with a source must be pinned by sha256 or commit");
            return null;
        }
    }
}

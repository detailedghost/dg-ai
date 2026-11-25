using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;

namespace Dg.Core.Tests.Plugins;

public sealed class ManifestParserTests
{
    private static readonly string[] ExactErrors =
    [
        "bad-capability.toml\tdg plugin: bad-capability.toml:9: capabilities.exec must be a list of strings. Next: fix capabilities.exec in bad-capability.toml, then run dg plugin verify.",
        "bad-name.toml\tdg plugin: bad-name.toml:1: name must be lowercase letters, digits and hyphens, starting with a letter. Next: fix name in bad-name.toml, then run dg plugin verify.",
        "bad-pin.toml\tdg plugin: bad-pin.toml:5: sha256 must be 64 hex characters. Next: fix sha256 in bad-pin.toml, then run dg plugin verify.",
        "bad-version.toml\tdg plugin: bad-version.toml:2: version must be a semantic version like 1.2.3, got one. Next: fix version in bad-version.toml, then run dg plugin verify.",
        "builtin-endpoint.toml\tdg plugin: builtin-endpoint.toml:4: a built-in plugin runs in process and takes no endpoint. Next: fix endpoint in builtin-endpoint.toml, then run dg plugin verify.",
        "entry-both.toml\tdg plugin: entry-both.toml:5: entry must set exactly one of builtin or command. Next: fix entry in entry-both.toml, then run dg plugin verify.",
        "http-no-endpoint.toml\tdg plugin: http-no-endpoint.toml:4: endpoint is required for the http transport. Next: fix transport in http-no-endpoint.toml, then run dg plugin verify.",
        "missing-entry.toml\tdg plugin: missing-entry.toml:1: entry is required: add an [entry] table with builtin or command. Next: fix entry in missing-entry.toml, then run dg plugin verify.",
        "missing-name.toml\tdg plugin: missing-name.toml:1: name is required. Next: fix name in missing-name.toml, then run dg plugin verify.",
        "remote-not-declared.toml\tdg plugin: remote-not-declared.toml:5: endpoint host policy.example.com is not loopback; set remote = true in plugin.toml and allow_remote = true in config.toml. Next: fix endpoint in remote-not-declared.toml, then run dg plugin verify.",
        "remote-over-ipc.toml\tdg plugin: remote-over-ipc.toml:6: remote needs the http transport with an https endpoint. Next: fix remote in remote-over-ipc.toml, then run dg plugin verify.",
        "remote-plain-http.toml\tdg plugin: remote-plain-http.toml:5: a remote endpoint must use https. Next: fix endpoint in remote-plain-http.toml, then run dg plugin verify.",
        "skill-unpinned.toml\tdg plugin: skill-unpinned.toml:1: a skill or a plugin with a source must be pinned by sha256 or commit. Next: fix sha256 in skill-unpinned.toml, then run dg plugin verify.",
        "two-pins.toml\tdg plugin: two-pins.toml:6: set only one of sha256 or commit. Next: fix commit in two-pins.toml, then run dg plugin verify.",
        "udp-hook.toml\tdg plugin: udp-hook.toml:4: a hook cannot use the udp transport; udp carries events only, never request and response. Next: fix transport in udp-hook.toml, then run dg plugin verify.",
        "unknown-key.toml\tdg plugin: unknown-key.toml:4: colour is not a plugin.toml key; the keys are name, version, kind, transport, endpoint, remote, source, sha256, commit, entry, capabilities, permissions. Next: fix colour in unknown-key.toml, then run dg plugin verify.",
        "unknown-kind.toml\tdg plugin: unknown-kind.toml:3: kind must be one of hook, job, skill, got \"widget\". Next: fix kind in unknown-kind.toml, then run dg plugin verify.",
        "unknown-transport.toml\tdg plugin: unknown-transport.toml:4: transport must be one of ipc, http, tcp, udp, got \"smoke\". Next: fix transport in unknown-transport.toml, then run dg plugin verify.",
        "url-secret.toml\tdg plugin: url-secret.toml:5: endpoint must not hold credentials in the endpoint URL; use the plugin token from dg credentials. Next: fix endpoint in url-secret.toml, then run dg plugin verify.",
    ];

    public static TheoryData<string> InvalidFiles()
    {
        var data = new TheoryData<string>();
        foreach (var file in PluginFixtures.Files("manifests/invalid", "*.toml"))
            data.Add(file);
        return data;
    }

    private static PluginManifest ParseValid(string file) =>
        ManifestParser.Parse(PluginFixtures.ReadText("manifests", "valid", file), file);

    private static PluginContractException ParseInvalid(string file) =>
        Assert.Throws<PluginContractException>(() =>
            ManifestParser.Parse(PluginFixtures.ReadText("manifests", "invalid", file), file)
        );

    [Fact]
    public void Parse_BuiltInHook_DefaultsToIpcAndBuiltinEntry()
    {
        var manifest = ParseValid("builtin-hook.toml");

        Assert.Equal("pr-guard", manifest.Name);
        Assert.Equal("1.0.0", manifest.Version);
        Assert.Equal(PluginKind.Hook, manifest.Kind);
        Assert.Equal(PluginTransportKind.Ipc, manifest.Transport);
        Assert.Null(manifest.Endpoint);
        Assert.False(manifest.Remote);
        Assert.Null(manifest.Pin);
        Assert.Equal("hooks.pr-guard", manifest.Entry.Builtin);
        Assert.Null(manifest.Entry.Command);
        Assert.Empty(manifest.Entry.Args);
        Assert.True(manifest.Entry.IsBuiltin);
    }

    [Fact]
    public void Parse_ExternalHookIpc_ReadsEveryTable()
    {
        var manifest = ParseValid("external-hook-ipc.toml");

        Assert.Equal("secret-scan.sock", manifest.Endpoint);
        Assert.Equal("https://github.com/example/dg-secret-scan", manifest.Source);
        Assert.Equal(new PluginPin(PluginPinKind.Commit, "0123456789abcdef0123456789abcdef01234567"), manifest.Pin);
        Assert.Equal("dg-secret-scan", manifest.Entry.Command);
        Assert.Equal(["--serve"], manifest.Entry.Args);
        Assert.False(manifest.Capabilities.Network);
        Assert.Equal(["."], manifest.Capabilities.FsRead);
        Assert.Empty(manifest.Capabilities.FsWrite);
        Assert.Equal(["git"], manifest.Capabilities.Exec);
        Assert.Equal(["plugin-secret-scan-token"], manifest.Permissions.Credentials);
        Assert.Equal(["HOME"], manifest.Permissions.Env);
    }

    [Fact]
    public void Parse_ExternalJobTcp_ReadsTransportAndEndpoint()
    {
        var manifest = ParseValid("external-job-tcp.toml");

        Assert.Equal(PluginKind.Job, manifest.Kind);
        Assert.Equal(PluginTransportKind.Tcp, manifest.Transport);
        Assert.Equal("127.0.0.1:7431", manifest.Endpoint);
        Assert.Empty(manifest.Entry.Args);
    }

    [Fact]
    public void Parse_EventsUdp_ReadsUdpTransport()
    {
        var manifest = ParseValid("events-udp.toml");

        Assert.Equal(PluginTransportKind.Udp, manifest.Transport);
        Assert.Equal("127.0.0.1:7432", manifest.Endpoint);
    }

    [Fact]
    public void Parse_RemoteHookHttp_ReadsRemoteAndSha256Pin()
    {
        var manifest = ParseValid("remote-hook-http.toml");

        Assert.Equal(PluginTransportKind.Http, manifest.Transport);
        Assert.True(manifest.Remote);
        Assert.Equal("https://policy.example.com/dg", manifest.Endpoint);
        Assert.Equal(
            new PluginPin(PluginPinKind.Sha256, "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
            manifest.Pin
        );
    }

    [Fact]
    public void Parse_SkillPinned_ReadsSkillKindAndEntryArgs()
    {
        var manifest = ParseValid("skill-pinned.toml");

        Assert.Equal(PluginKind.Skill, manifest.Kind);
        Assert.Equal(["describe"], manifest.Entry.Args);
        Assert.Equal(PluginPinKind.Sha256, manifest.Pin!.Kind);
    }

    [Theory]
    [MemberData(nameof(InvalidFiles))]
    public void Parse_InvalidFixture_ReportsExpectedLineKeyAndText(string file)
    {
        using var expected = PluginFixtures.ReadJson("manifests", "invalid", "expected.json");
        var entry = expected.RootElement.GetProperty(file);
        var line = entry.GetProperty("line").GetInt32();

        var error = ParseInvalid(file);

        Assert.StartsWith($"dg plugin: {file}:{line}: ", error.Message);
        Assert.Contains(entry.GetProperty("includes").GetString()!, error.Message);
        Assert.Contains(". Next: fix ", error.Message);
        Assert.EndsWith("then run dg plugin verify.", error.Message);
    }

    [Theory]
    [MemberData(nameof(InvalidFiles))]
    public void Parse_InvalidFixture_MatchesBunErrorTextExactly(string file)
    {
        var exact = ExactErrors.SingleOrDefault(line => line.StartsWith(file + "\t", StringComparison.Ordinal));
        if (exact is null)
        {
            Assert.Equal("syntax-error.toml", file);
            return;
        }

        Assert.Equal(exact.Split('\t')[1], ParseInvalid(file).Message);
    }

    [Fact]
    public void Parse_SyntaxError_NamesTomlAndNextStep()
    {
        var error = ParseInvalid("syntax-error.toml");

        Assert.StartsWith("dg plugin: syntax-error.toml:2: plugin.toml is not valid TOML: ", error.Message);
        Assert.EndsWith(". Next: fix the line, then run dg plugin verify.", error.Message);
    }

    [Fact]
    public void Parse_CrLfManifest_ReportsSameLine()
    {
        var text = PluginFixtures.ReadText("manifests", "invalid", "unknown-key.toml").ReplaceLineEndings("\r\n");

        var error = Assert.Throws<PluginContractException>(() => ManifestParser.Parse(text, "unknown-key.toml"));

        Assert.StartsWith("dg plugin: unknown-key.toml:4: ", error.Message);
    }

    [Fact]
    public void PermissionReport_ExternalPlugin_SplitsEnforcedFromUnenforced()
    {
        var report = PermissionReport.For(ParseValid("external-hook-ipc.toml"));

        Assert.Equal(
            [
                "exec allowlist: git",
                "credentials: plugin-secret-scan-token",
                "environment: HOME",
                "working directory: the plugin folder",
                "timeouts: per route",
            ],
            report.Enforced
        );
        Assert.Equal(["network access: not declared", "file read: .", "file write: none"], report.Unenforced);
    }

    [Fact]
    public void PermissionReport_BuiltInPlugin_IsEmpty()
    {
        var report = PermissionReport.For(ParseValid("builtin-hook.toml"));

        Assert.Empty(report.Enforced);
        Assert.Empty(report.Unenforced);
    }
}

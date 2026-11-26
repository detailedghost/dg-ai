using System.Text.Json;
using Dg.Core.Config;
using Dg.Core.Paths;
using Dg.Core.Tests.Config;

namespace Dg.Core.Tests.Paths;

public sealed class DgPathsParityTests
{
    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        using var document = JsonDocument.Parse(FixtureFiles.Read("paths.cases.json"));
        foreach (var entry in document.RootElement.EnumerateArray())
            data.Add(entry.GetProperty("name").GetString()!);
        return data;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Resolve_FixtureCase_MatchesBunPathsAndFenceError(string name)
    {
        using var cases = JsonDocument.Parse(FixtureFiles.Read("paths.cases.json"));
        using var expected = JsonDocument.Parse(FixtureFiles.Read("paths.expected.json"));
        var input = cases.RootElement.EnumerateArray().Single(e => e.GetProperty("name").GetString() == name);
        var output = expected.RootElement.EnumerateArray().Single(e => e.GetProperty("name").GetString() == name);
        Dictionary<string, string?> env = [];
        foreach (var variable in input.GetProperty("env").EnumerateObject())
            env[variable.Name] = variable.Value.GetString();
        var platform = input.GetProperty("platform").GetString() switch
        {
            "darwin" => DgPlatform.MacOs,
            "win32" => DgPlatform.Windows,
            _ => DgPlatform.Linux,
        };

        var result = DgPaths.Resolve(new DgPathSeams(platform, input.GetProperty("home").GetString()!, "/unused", env));

        if (output.TryGetProperty("error", out var message))
        {
            Assert.NotNull(result.Error);
            Assert.Equal(message.GetString(), ConfigErrorText.Render(result.Error));
            return;
        }
        Assert.True(result.IsOk);
        Assert.Equal(
            output.GetProperty("paths").EnumerateObject().Select(p => (p.Name, p.Value.GetString()!)),
            Fields(result.Value!)
        );
    }

    [Fact]
    public void Resolve_RelativeDgHome_ResolvesAgainstCwd()
    {
        Dictionary<string, string?> env = new() { ["DG_HOME"] = "rel/../dg" };

        var paths = DgPaths.Resolve(new DgPathSeams(DgPlatform.Linux, "/home/u", "/work/tree", env)).GetOrThrow();

        Assert.Equal("/work/tree/dg/config/config.toml", paths.ConfigTomlPath);
        Assert.Equal("/work/tree/dg", paths.LegacyHome);
    }

    [Theory]
    [InlineData("/home/u", "XDG_CONFIG_HOME", "/xdg", "/xdg/dg/config.toml")]
    [InlineData("/home/u", "DG_HOME", "/srv/dg", "/srv/dg/config/config.toml")]
    [InlineData("/home/u", "XDG_STATE_HOME", "/xdg", "/home/u/.config/dg/config.toml")]
    public void Resolve_ConfigTomlPath_FollowsAdr0054(string home, string name, string value, string expected)
    {
        Dictionary<string, string?> env = new() { [name] = value };

        var paths = DgPaths.Resolve(new DgPathSeams(DgPlatform.Linux, home, "/", env)).GetOrThrow();

        Assert.Equal(expected, paths.ConfigTomlPath);
    }

    private static (string Name, string Value)[] Fields(DgPaths paths)
    {
        (string Name, string Value)[] fields =
        [
            ("binDir", paths.BinDir),
            ("configDir", paths.ConfigDir),
            ("dataDir", paths.DataDir),
            ("stateDir", paths.StateDir),
            ("cacheDir", paths.CacheDir),
            ("logDir", paths.LogDir),
            ("configPath", paths.ConfigPath),
            ("configTomlPath", paths.ConfigTomlPath),
            ("execAllowlistPath", paths.ExecAllowlistPath),
            ("cliOnlyMarker", paths.CliOnlyMarker),
            ("runtimeDir", paths.RuntimeDir),
            ("libDir", paths.LibDir),
            ("browsersDir", paths.BrowsersDir),
            ("skillsDir", paths.SkillsDir),
            ("personasDir", paths.PersonasDir),
            ("daemonDir", paths.DaemonDir),
            ("pidPath", paths.PidPath),
            ("dbPath", paths.DbPath),
            ("credentialsDbPath", paths.CredentialsDbPath),
            ("keyPath", paths.KeyPath),
            ("daemonConfigPath", paths.DaemonConfigPath),
            ("agentsDir", paths.AgentsDir),
            ("sessionsDir", paths.SessionsDir),
            ("assetsDir", paths.AssetsDir),
            ("memoryDbPath", paths.MemoryDbPath),
            ("grantsDir", paths.GrantsDir),
            ("phoneRoot", paths.PhoneRoot),
            ("phoneFriendRoot", paths.PhoneFriendRoot),
            ("jobsDir", paths.JobsDir),
            ("jobSourcesPath", paths.JobSourcesPath),
            ("jobStateRoot", paths.JobStateRoot),
            ("legacyHome", paths.LegacyHome),
        ];
        return fields;
    }
}

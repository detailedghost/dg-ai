using Dg.Cli;
using Dg.Core.Config;

namespace Dg.Parity.Tests;

public sealed class FrontGateTests : IDisposable
{
    private readonly string _home = Directory.CreateTempSubdirectory("dg-front-gate-").FullName;

    public void Dispose() => Directory.Delete(_home, recursive: true);

    [Fact]
    public void Decide_NoEnvNoConfigFile_IsNativeWithoutParsing()
    {
        var choice = FrontGate.Decide(Env());

        Assert.True(choice.Native);
        Assert.Null(choice.Toml);
    }

    [Fact]
    public void Decide_DgFrontZero_IsCoreEvenWithValidConfig()
    {
        WriteConfig("[front]\nenabled = true\n");

        Assert.False(FrontGate.Decide(Env(("DG_FRONT", "0"))).Native);
    }

    [Fact]
    public void Decide_DgFrontZero_IsCoreEvenWithBrokenConfig()
    {
        WriteConfig("[front\n");

        Assert.False(FrontGate.Decide(Env(("DG_FRONT", "0"))).Native);
    }

    [Fact]
    public void Decide_DgFrontOne_BeatsConfigThatDisablesFront()
    {
        WriteConfig("[front]\nenabled = false\n");

        Assert.True(FrontGate.Decide(Env(("DG_FRONT", "1"))).Native);
    }

    [Fact]
    public void Decide_ConfigFrontDisabled_IsCore()
    {
        WriteConfig("[front]\nenabled = false\n");

        Assert.False(FrontGate.Decide(Env()).Native);
    }

    [Fact]
    public void Decide_ConfigFrontEnabled_IsNativeAndKeepsParsedToml()
    {
        WriteConfig("[front]\nenabled = true\n\n[browser]\nmode = \"ext\"\n");

        var choice = FrontGate.Decide(Env());

        Assert.True(choice.Native);
        Assert.Equal(BrowserMode.Ext, choice.Toml!.BrowserMode);
    }

    [Theory]
    [InlineData("[browser\nmode = \"ext\"\n")]
    [InlineData("[browser]\nmode = \"loud\"\n")]
    [InlineData("[nope]\nx = 1\n")]
    public void Decide_ConfigDoesNotLoad_IsCore(string config)
    {
        WriteConfig(config);

        Assert.False(FrontGate.Decide(Env()).Native);
    }

    [Fact]
    public void Decide_PathsEscapeTheFence_IsCore()
    {
        var env = Env(("DG_PATH_FENCE", Path.Combine(_home, "inside")));

        Assert.False(FrontGate.Decide(env).Native);
    }

    private Dictionary<string, string?> Env(params (string Key, string Value)[] extra)
    {
        Dictionary<string, string?> env = new(StringComparer.Ordinal)
        {
            ["DG_HOME"] = _home,
            ["DG_PATH_FENCE"] = _home,
            ["HOME"] = _home,
        };
        foreach (var (key, value) in extra)
            env[key] = value;
        return env;
    }

    private void WriteConfig(string text)
    {
        var file = Path.Combine(_home, "config", "config.toml");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text);
    }
}

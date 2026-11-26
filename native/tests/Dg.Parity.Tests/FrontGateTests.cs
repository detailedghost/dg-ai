using Dg.Cli;

namespace Dg.Parity.Tests;

public sealed class FrontGateTests : IDisposable
{
    private readonly string _home = Directory.CreateTempSubdirectory("dg-front-gate-").FullName;

    public void Dispose() => Directory.Delete(_home, recursive: true);

    [Fact]
    public void IsNative_NoEnvNoConfigFile_IsTrue()
    {
        Assert.True(FrontGate.IsNative(Env()));
    }

    [Fact]
    public void IsNative_DgFrontZero_IsFalseEvenWithValidConfig()
    {
        WriteConfig("[front]\nenabled = true\n");

        Assert.False(FrontGate.IsNative(Env(("DG_FRONT", "0"))));
    }

    [Fact]
    public void IsNative_DgFrontZero_IsFalseEvenWithBrokenConfig()
    {
        WriteConfig("[front\n");

        Assert.False(FrontGate.IsNative(Env(("DG_FRONT", "0"))));
    }

    [Fact]
    public void IsNative_DgFrontOne_BeatsConfigThatDisablesFront()
    {
        WriteConfig("[front]\nenabled = false\n");

        Assert.True(FrontGate.IsNative(Env(("DG_FRONT", "1"))));
    }

    [Fact]
    public void IsNative_ConfigFrontDisabled_IsFalse()
    {
        WriteConfig("[front]\nenabled = false\n");

        Assert.False(FrontGate.IsNative(Env()));
    }

    [Fact]
    public void IsNative_ConfigFrontEnabledWithOtherKeys_IsTrue()
    {
        WriteConfig("[front]\nenabled = true\n\n[pw]\nmode = \"ext\"\n");

        Assert.True(FrontGate.IsNative(Env()));
    }

    [Theory]
    [InlineData("[pw\nmode = \"ext\"\n")]
    [InlineData("[pw]\nmode = \"loud\"\n")]
    [InlineData("[nope]\nx = 1\n")]
    public void IsNative_ConfigDoesNotLoad_IsFalse(string config)
    {
        WriteConfig(config);

        Assert.False(FrontGate.IsNative(Env()));
    }

    [Fact]
    public void IsNative_PathsEscapeTheFence_IsFalse()
    {
        var env = Env(("DG_PATH_FENCE", Path.Combine(_home, "inside")));

        Assert.False(FrontGate.IsNative(env));
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

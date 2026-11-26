using Dg.Core.Config;
using Dg.Core.Paths;

namespace Dg.Core.Tests.Config;

public sealed class DgConfigLoadTests : IDisposable
{
    private readonly string _home = Directory.CreateTempSubdirectory("dg-core-config-").FullName;

    public void Dispose() => Directory.Delete(_home, recursive: true);

    private Dictionary<string, string?> Env() => new() { ["DG_HOME"] = _home, ["DG_PATH_FENCE"] = _home };

    private void WriteConfig(string text)
    {
        var file = Path.Combine(_home, "config", "config.toml");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text);
    }

    [Fact]
    public void Load_NoFile_ReturnsDocumentedDefaults()
    {
        var toml = DgConfig.Load(Env()).GetOrThrow();

        Assert.Equal(PwMode.Auto, toml.PwMode);
        Assert.Empty(toml.PwPhiSites);
        Assert.True(toml.FrontEnabled);
        Assert.False(toml.InstallCliOnly);
        Assert.Empty(toml.Plugins);
    }

    [Fact]
    public void Load_DgHomeFile_ReadsValues()
    {
        WriteConfig("[pw]\nmode = \"ext\"\nphi_sites = [\"https://a.org\"]\n\n[front]\nenabled = false\n\n[plugins.acme]\nallow_remote = true\nfail_closed = true\n");

        var toml = DgConfig.Load(Env()).GetOrThrow();

        Assert.Equal(PwMode.Ext, toml.PwMode);
        Assert.Equal(["https://a.org"], toml.PwPhiSites);
        Assert.False(toml.FrontEnabled);
        Assert.True(toml.Plugins["acme"].AllowRemote);
        Assert.True(toml.Plugins["acme"].FailClosed);
        Assert.True(toml.Plugins["acme"].Enabled);
    }

    [Fact]
    public void Load_BadKey_NamesFileLineKeyAndNextStep()
    {
        WriteConfig("[pw]\nmode = \"ext\"\ncolor = \"red\"\n");

        var error = DgConfig.Load(Env()).Error;

        Assert.NotNull(error);
        Assert.Equal(Path.Combine(_home, "config", "config.toml"), error.File);
        Assert.Equal(3, error.Line);
        Assert.Equal("pw.color", error.Key);
        Assert.Equal(
            $"dg config: {error.File}:3: pw.color is not a dg config key. Next: run dg config edit, or dg config set pw.<key> <value>.",
            ConfigErrorText.Render(error)
        );
    }

    [Fact]
    public void Load_FenceOutsideHome_ReturnsFenceError()
    {
        var env = new Dictionary<string, string?> { ["DG_HOME"] = _home, ["DG_PATH_FENCE"] = Path.Combine(_home, "inner") };

        var error = DgConfig.Load(env).Error;

        Assert.NotNull(error);
        Assert.StartsWith("dg path fence: binDir ", ConfigErrorText.Render(error));
    }
}

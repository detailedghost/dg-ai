using Dg.Core.Config;

namespace Dg.Core.Tests.Config;

public sealed class ConfigRulesTests
{
    private const string Sample =
        "[front]\nenabled = true\n[hooks.spelling]\nlocale = \"en-US\"\n[refs]\ndefault_repo = \"a/b\"\n[refs.aliases]\nx = \"y\"\n[plugins.a]\nenabled = true\n[plugins.a.settings]\nk = \"v\"\n";

    [Theory]
    [InlineData("inbox.gmail.clientSecret", true)]
    [InlineData("plugins.a.settings.token", true)]
    [InlineData("plugins.a.settings.nested.apiKey", true)]
    [InlineData("plugins.a.settings.PASSWORD", true)]
    [InlineData("plugins..settings.token", true)]
    [InlineData("plugins.a.settings.name", false)]
    [InlineData("plugins.a.settings", false)]
    [InlineData("plugins.a.settings.", false)]
    [InlineData("plugins.a.enabled.token", false)]
    [InlineData("plugins.a.b.settings.token", false)]
    [InlineData("plugins.settings.x.token", false)]
    [InlineData("plugins", false)]
    [InlineData("plugins.a", false)]
    [InlineData("browser.token", false)]
    [InlineData("", false)]
    public void IsSecretKey_Key_MatchesPluginSettingSecretNames(string key, bool expected) =>
        Assert.Equal(expected, ConfigRules.IsSecretKey(key));

    [Theory]
    [InlineData("plugins.a.settings", true)]
    [InlineData("plugins.a.settings.k", true)]
    [InlineData("plugins.a.b.settings.k", false)]
    [InlineData("plugins.a", false)]
    [InlineData("plugins", false)]
    [InlineData("hooks.a.settings.k", false)]
    public void IsPluginSetting_Key_RequiresSettingsAsThirdPart(string key, bool expected) =>
        Assert.Equal(expected, ConfigRules.IsPluginSetting(key));

    [Theory]
    [InlineData("a.b", false)]
    [InlineData("install.cli_only", false)]
    [InlineData("", true)]
    [InlineData("a..b", true)]
    [InlineData(".a", true)]
    [InlineData("a.", true)]
    [InlineData("a.__proto__", true)]
    [InlineData("constructor.a", true)]
    [InlineData("a.prototype.b", true)]
    [InlineData("a.constructors", false)]
    public void IsInvalid_Key_RejectsEmptyAndUnsafeParts(string key, bool expected) =>
        Assert.Equal(expected, ConfigRules.IsInvalid(key));

    [Fact]
    public void KeyChecks_RepeatedCalls_AllocateNothing()
    {
        var bytes = AllocationProbe.BytesPerOp(() =>
        {
            ConfigRules.IsSecretKey("plugins.a.settings.nested.apiKey");
            ConfigRules.IsSecretKey("front.enabled");
            ConfigRules.IsInvalid("plugins.a.settings.nested.apiKey");
            ConfigRules.IsPluginSetting("plugins.a.settings.nested.apiKey");
        });

        Assert.True(bytes <= 16, $"key checks allocated {bytes} B/op");
    }

    [Fact]
    public void Parse_SmallConfig_StaysUnderParseBudget()
    {
        var bytes = AllocationProbe.BytesPerOp(() => DgConfig.Parse(Sample, "config.toml"), 200);

        Assert.True(bytes <= 11_800, $"DgConfig.Parse allocated {bytes} B/op");
    }
}

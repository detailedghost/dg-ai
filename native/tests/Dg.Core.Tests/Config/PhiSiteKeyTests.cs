using System.Text;
using Dg.Core.Config;

namespace Dg.Core.Tests.Config;

public sealed class PhiSiteKeyTests
{
    private static bool Accepts(string key) => DgConfig.Parse($"[pw]\nphi_sites = [\"{key}\"]\n", "config.toml").IsOk;

    [Theory]
    [InlineData("https://example.org")]
    [InlineData("http://example.org:8080")]
    [InlineData("http://[::1]")]
    [InlineData("http://[::1]:3000")]
    [InlineData("http://127.0.0.1")]
    [InlineData("https://xn--bcher-kva.example")]
    public void Parse_KeyThatTheTsRuleAccepts_IsAccepted(string key) => Assert.True(Accepts(key));

    [Theory]
    [InlineData("https://example.org:443")]
    [InlineData("http://example.org:80")]
    [InlineData("https://:")]
    [InlineData("http://[")]
    [InlineData("http://[0:0::1]")]
    [InlineData("http://[::ffff:1.2.3.4]")]
    [InlineData("https://127.1")]
    [InlineData("https://1")]
    [InlineData("https://0x7f.1")]
    [InlineData("https://example.org:")]
    [InlineData("https://example.org:99999")]
    [InlineData("https://a.org:08080")]
    [InlineData("http://:8080")]
    [InlineData("https://a:b:c")]
    [InlineData("https://Example.org")]
    [InlineData("https://a_b.org")]
    [InlineData("https://example.org.")]
    [InlineData("https://.")]
    [InlineData("https://example.org:0")]
    [InlineData("http://[::1]:0")]
    [InlineData("https://a..b")]
    [InlineData("https://-a.org")]
    [InlineData("https://a-.org")]
    [InlineData("https://a.-b.org")]
    [InlineData("https://a.b-.org")]
    [InlineData("https://.a.org")]
    public void Parse_KeyThatTheTsRuleRefuses_IsRefused(string key) => Assert.False(Accepts(key));

    [Fact]
    public void Parse_ExactlyMaxSites_IsAccepted() => Assert.True(Config(256).IsOk);

    [Fact]
    public void Parse_OneOverMaxSites_IsRefused()
    {
        var result = Config(257);

        Assert.False(result.IsOk);
        Assert.Contains("pw.phi_sites holds more than 256 site keys", ConfigErrorText.Render(result.Error!));
    }

    private static ConfigResult<DgToml> Config(int count)
    {
        var text = new StringBuilder("[pw]\nphi_sites = [");
        for (var i = 0; i < count; i++)
            text.Append(i == 0 ? "" : ", ").Append($"\"https://h{i}.org\"");
        return DgConfig.Parse(text.Append("]\n").ToString(), "config.toml");
    }
}

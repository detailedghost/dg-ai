using System.Text;
using Dg.Core.Abstractions;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Plugins.Tests;

public sealed class PluginCommandTests
{
    private const string Tree = "ad7e6af574581b2aa163ec1edd9d2ab960f7ada2d2c532229c811f830522b54b";
    private static readonly string Mac = new('b', 64);

    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;

    [Fact]
    public void AddPlugins_Registers_ListVerifyEnableAndDisable()
    {
        var services = new FakeServices();

        services.AddPlugins();

        var names = services
            .Where(static d => d.ServiceType == typeof(ICommand))
            .Select(static d => ((ICommand)d.ImplementationFactory!(null!)).Name)
            .Order()
            .ToArray();
        Assert.Equal(["plugin disable", "plugin enable", "plugin list", "plugin verify"], names);
    }

    [Fact]
    public void Verify_ApproveAtATerminal_HandsOffToDgCoreAndWritesNothing()
    {
        using var home = new TempHome(hasTerminal: true);
        home.Write("data/plugins/gamma/src/SKILL.md", "---\nname: gamma\n---\nGamma.\n");
        home.Write("data/plugins/gamma/dg-plugin.json", Json("null", null));
        home.Write("config/config.toml", "");
        var before = home.Run("plugin", "verify", "gamma").Files;

        var run = home.Run("plugin", "verify", "gamma", "--approve");

        Assert.Equal(ExitCodes.NotNative, run.Exit);
        Assert.Equal("", run.Stdout);
        Assert.Equal("", run.Stderr);
        Assert.Equal(before, run.Files);
    }

    [Fact]
    public void Verify_ApproveWithoutTerminal_RefusesAndWritesNothing()
    {
        using var home = new TempHome();
        home.Write("data/plugins/gamma/src/SKILL.md", "---\nname: gamma\n---\nGamma.\n");
        home.Write("data/plugins/gamma/dg-plugin.json", Json("null", null));
        var before = home.Run("plugin", "verify", "gamma").Files;

        var run = home.Run("plugin", "verify", "gamma", "--approve");

        Assert.Equal(1, run.Exit);
        Assert.Equal("", run.Stdout);
        Assert.Equal("dg plugin verify --approve needs a person at a terminal; run it yourself.\n", run.Stderr);
        Assert.Equal(before, run.Files);
    }

    private static string Json(string approved, string? mac)
    {
        var macLine = mac is null ? "" : $",\n\t\"mac\": {mac}";
        return $"{{\n\t\"name\": \"gamma\",\n\t\"kind\": \"skill\",\n\t\"source\": \"s\",\n"
            + $"\t\"pin\": {{\n\t\t\"kind\": \"sha256\",\n\t\t\"value\": \"{Tree}\"\n\t}},\n"
            + $"\t\"treeSha256\": \"{Tree}\",\n\t\"approvedSha256\": {approved}{macLine}\n}}\n";
    }

    [Fact]
    public void Parse_RecordWithoutMacKey_HasNullMac()
    {
        var record = PluginRecord.Parse(Encoding.UTF8.GetBytes(Json("null", null)), "gamma");

        Assert.Null(record.Mac);
    }

    [Fact]
    public void ToJson_RecordWithMac_RoundTripsTheMacKey()
    {
        var text = Json($"\"{Tree}\"", $"\"{Mac}\"");

        var record = PluginRecord.Parse(Encoding.UTF8.GetBytes(text), "gamma");

        Assert.Equal(Mac, record.Mac);
        Assert.Equal(text, record.ToJson());
    }

    [Fact]
    public void ToJson_RecordWithNullMac_WritesNull()
    {
        var record = PluginRecord.Parse(Encoding.UTF8.GetBytes(Json("null", "null")), "gamma");

        Assert.Null(record.Mac);
        Assert.Equal(Json("null", "null"), record.ToJson());
    }

    [Theory]
    [InlineData("\"short\"")]
    [InlineData("1")]
    public void Parse_MalformedMac_IsNotNative(string mac) =>
        Assert.Throws<NotNativeException>(() =>
            PluginRecord.Parse(Encoding.UTF8.GetBytes(Json("null", mac)), "gamma")
        );

    [Fact]
    public void AssertUnapproved_RecordThatClaimsApproval_NeedsDgCore()
    {
        var claims = PluginRecord.Parse(Encoding.UTF8.GetBytes(Json($"\"{Tree}\"", $"\"{Mac}\"")), "gamma");

        Assert.Throws<NotNativeException>(() => PluginStore.AssertUnapproved(claims));
    }

    [Fact]
    public void AssertUnapproved_RecordThatNeverClaimedApproval_StaysNative()
    {
        var record = PluginRecord.Parse(Encoding.UTF8.GetBytes(Json("null", null)), "gamma");

        PluginStore.AssertUnapproved(record);
    }
}

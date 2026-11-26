using System.Text;
using Dg.Core.Abstractions;
using Dg.Core.Paths;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Plugins.Tests;

public sealed class PluginCommandTests
{
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
        const string tree = "ad7e6af574581b2aa163ec1edd9d2ab960f7ada2d2c532229c811f830522b54b";
        using var home = new TempHome(hasTerminal: true);
        home.Write("data/plugins/gamma/src/SKILL.md", "---\nname: gamma\n---\nGamma.\n");
        home.Write(
            "data/plugins/gamma/dg-plugin.json",
            $"{{\n\t\"name\": \"gamma\",\n\t\"kind\": \"skill\",\n\t\"source\": \"s\",\n\t\"pin\": {{\n\t\t\"kind\": \"sha256\",\n\t\t\"value\": \"{tree}\"\n\t}},\n\t\"treeSha256\": \"{tree}\",\n\t\"approvedSha256\": null\n}}\n"
        );
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
        const string tree = "ad7e6af574581b2aa163ec1edd9d2ab960f7ada2d2c532229c811f830522b54b";
        using var home = new TempHome();
        home.Write("data/plugins/gamma/src/SKILL.md", "---\nname: gamma\n---\nGamma.\n");
        home.Write(
            "data/plugins/gamma/dg-plugin.json",
            $"{{\n\t\"name\": \"gamma\",\n\t\"kind\": \"skill\",\n\t\"source\": \"s\",\n\t\"pin\": {{\n\t\t\"kind\": \"sha256\",\n\t\t\"value\": \"{tree}\"\n\t}},\n\t\"treeSha256\": \"{tree}\",\n\t\"approvedSha256\": null\n}}\n"
        );
        var before = home.Run("plugin", "verify", "gamma").Files;

        var run = home.Run("plugin", "verify", "gamma", "--approve");

        Assert.Equal(1, run.Exit);
        Assert.Equal("", run.Stdout);
        Assert.Equal("dg plugin verify --approve needs a person at a terminal; run it yourself.\n", run.Stderr);
        Assert.Equal(before, run.Files);
    }

    private const string Tree = "ad7e6af574581b2aa163ec1edd9d2ab960f7ada2d2c532229c811f830522b54b";
    private static readonly string Mac = new('b', 64);

    private static string Json(string approved, string? mac) =>
        $"{{\n\t\"name\": \"gamma\",\n\t\"kind\": \"skill\",\n\t\"source\": \"s\",\n\t\"pin\": {{\n\t\t\"kind\": \"sha256\",\n\t\t\"value\": \"{Tree}\"\n\t}},\n\t\"treeSha256\": \"{Tree}\",\n\t\"approvedSha256\": {approved}{(mac is null ? "" : $",\n\t\"mac\": {mac}")}\n}}\n";

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
        Assert.Throws<NotNativeException>(() => PluginRecord.Parse(Encoding.UTF8.GetBytes(Json("null", mac)), "gamma"));

    [Fact]
    public void IsApproved_RecordThatClaimsApproval_NeedsDgCore()
    {
        using var home = new TempHome();
        var seams = DgPathSeams.Current(new Dictionary<string, string?> { ["DG_HOME"] = home.Root, ["DG_PATH_FENCE"] = home.Root, ["HOME"] = home.Root });
        var store = new PluginStore(DgPaths.Resolve(seams).Value!, seams);
        var claims = PluginRecord.Parse(Encoding.UTF8.GetBytes(Json($"\"{Tree}\"", $"\"{Mac}\"")), "gamma");

        Assert.Throws<NotNativeException>(() => store.IsApproved(claims));
    }

    [Fact]
    public void IsApproved_RecordThatNeverClaimedApproval_StaysNative()
    {
        using var home = new TempHome();
        var seams = DgPathSeams.Current(new Dictionary<string, string?> { ["DG_HOME"] = home.Root, ["DG_PATH_FENCE"] = home.Root, ["HOME"] = home.Root });
        var store = new PluginStore(DgPaths.Resolve(seams).Value!, seams);
        var record = PluginRecord.Parse(Encoding.UTF8.GetBytes(Json("null", null)), "gamma");

        Assert.False(store.IsApproved(record));
    }
}

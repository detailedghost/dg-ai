using System.Runtime.Versioning;
using Dg.Core.Abstractions;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Plugins.Tests;

public sealed class PluginCommandTests
{
    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;

    [Fact]
    public void AddPlugins_Registers_OnlyListAndVerify()
    {
        var services = new FakeServices();

        services.AddPlugins();

        var names = services
            .Where(static d => d.ServiceType == typeof(ICommand))
            .Select(static d => ((ICommand)d.ImplementationFactory!(null!)).Name)
            .Order()
            .ToArray();
        Assert.Equal(["plugin list", "plugin verify"], names);
    }

    [Fact]
    [UnsupportedOSPlatform("windows")]
    public void Verify_Approve_WritesPrivateRecordAndKeepsExecuteBit()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix file modes");
        const string tree = "ad7e6af574581b2aa163ec1edd9d2ab960f7ada2d2c532229c811f830522b54b";
        using var home = new TempHome(hasTerminal: true);
        home.Write("data/plugins/gamma/src/SKILL.md", "---\nname: gamma\n---\nGamma.\n");
        home.Write(
            "data/plugins/gamma/dg-plugin.json",
            $"{{\n\t\"name\": \"gamma\",\n\t\"kind\": \"skill\",\n\t\"source\": \"s\",\n\t\"pin\": {{\n\t\t\"kind\": \"sha256\",\n\t\t\"value\": \"{tree}\"\n\t}},\n\t\"treeSha256\": \"{tree}\",\n\t\"approvedSha256\": null\n}}\n"
        );
        home.Write("config/config.toml", "");
        var skill = Path.Combine(home.Root, "data/plugins/gamma/src/SKILL.md");
        File.SetUnixFileMode(skill, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

        var run = home.Run("plugin", "verify", "gamma", "--approve");

        Assert.Equal(0, run.Exit);
        var record = Path.Combine(home.Root, "data/plugins/gamma/dg-plugin.json");
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(record));
        var loaded = Path.Combine(home.Root, "data/plugins/gamma/skills/gamma/SKILL.md");
        Assert.Equal(
            UnixFileMode.UserRead
                | UnixFileMode.UserWrite
                | UnixFileMode.UserExecute
                | UnixFileMode.GroupRead
                | UnixFileMode.GroupExecute
                | UnixFileMode.OtherRead
                | UnixFileMode.OtherExecute,
            File.GetUnixFileMode(loaded)
        );
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
}

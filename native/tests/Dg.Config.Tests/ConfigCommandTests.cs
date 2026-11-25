using Dg.Core.Abstractions;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Config.Tests;

public sealed class ConfigCommandTests
{
    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;

    [Fact]
    public void AddConfig_Registers_FourMultiWordCommands()
    {
        var services = new FakeServices();

        services.AddConfig();

        var names = services
            .Where(static d => d.ServiceType == typeof(ICommand))
            .Select(static d => ((ICommand)d.ImplementationFactory!(null!)).Name)
            .Order()
            .ToArray();
        Assert.Equal(["config doctor", "config get", "config list", "config set"], names);
    }

    [Fact]
    public void List_WithNoFile_PrintsEffectiveDefaults()
    {
        using var home = new TempHome();

        var run = home.Run("config", "list");

        Assert.Equal(0, run.Exit);
        Assert.Equal(
            "browser.mode = auto\nfront.enabled = true\ninstall.cli_only = false\nssms.allow_send = false\nssms.google.send_enabled = false\n",
            run.Stdout
        );
    }

    [Fact]
    public void List_WithFile_AddsAliasesAndPluginsAfterDefaults()
    {
        using var home = new TempHome();
        home.Write(
            "config/config.toml",
            "[browser]\nmode = \"ext\"\n[refs]\ndefault_repo = \"o/r\"\n[refs.aliases]\napp = \"o/app\"\n[plugins.x]\nsource = \"./x\"\n"
        );

        var run = home.Run("config", "list");

        Assert.Equal(
            "browser.mode = ext\nfront.enabled = true\ninstall.cli_only = false\nssms.allow_send = false\nssms.google.send_enabled = false\nrefs.default_repo = o/r\nrefs.aliases.app = o/app\nplugins.x.enabled = true\nplugins.x.source = ./x\n",
            run.Stdout
        );
    }

    [Fact]
    public void List_InvalidFile_PrintsErrorAndExitsOne()
    {
        using var home = new TempHome();
        home.Write("config/config.toml", "[nope]\nx = 1\n");

        var run = home.Run("config", "list");

        Assert.Equal(1, run.Exit);
        Assert.Equal(
            "dg: dg config: <home>/config/config.toml:1: nope is not a dg config section. Next: run dg config edit, or dg config set <section>.<key> <value>.\n",
            run.Stderr
        );
    }

    [Fact]
    public void Doctor_ValidFile_ReportsValid()
    {
        using var home = new TempHome();
        home.Write("config/config.toml", "[install]\ncli_only = true\n");

        var run = home.Run("config", "doctor");

        Assert.Equal(0, run.Exit);
        Assert.Equal("<home>/config/config.toml is valid\n", run.Stdout);
    }

    [Fact]
    public void Doctor_NoFile_ReportsDefaultsInUse()
    {
        using var home = new TempHome();

        var run = home.Run("config", "doctor");

        Assert.Equal(0, run.Exit);
        Assert.Equal("<home>/config/config.toml does not exist; defaults apply\n", run.Stdout);
    }

    [Fact]
    public void Doctor_InvalidFile_PrintsErrorAndExitsOne()
    {
        using var home = new TempHome();
        home.Write("config/config.toml", "[browser]\nmode = \"loud\"\n");

        var run = home.Run("config", "doctor");

        Assert.Equal(1, run.Exit);
        Assert.StartsWith("dg: dg config: <home>/config/config.toml:2: browser.mode must be", run.Stderr);
    }

    [Fact]
    public void Doctor_LegacySourceWithoutFile_SignalsNotNative()
    {
        using var home = new TempHome();
        home.Write("config/cli-only", "");

        Assert.Equal(ConfigExit.NotNative, home.Run("config", "doctor").Exit);
    }

    [Fact]
    public void Set_NewFile_CreatesItOwnerOnly()
    {
        using var home = new TempHome();

        home.Run("config", "set", "install.cli_only", "true");

        if (!OperatingSystem.IsWindows())
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(home.ConfigFile)
            );
    }

    [Fact]
    public void Set_ExistingFile_KeepsItsMode()
    {
        if (OperatingSystem.IsWindows())
            return;
        using var home = new TempHome();
        home.Write("config/config.toml", "[install]\ncli_only = false\n");
        File.SetUnixFileMode(home.ConfigFile, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead);

        home.Run("config", "set", "install.cli_only", "true");

        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead,
            File.GetUnixFileMode(home.ConfigFile)
        );
    }

    [Fact]
    public void Set_Invalid_LeavesFileBytesUnchanged()
    {
        using var home = new TempHome();
        const string original = "[install]\ncli_only = true\n";
        home.Write("config/config.toml", original);

        home.Run("config", "set", "browser.mode", "loud");

        Assert.Equal(original, File.ReadAllText(home.ConfigFile));
    }
}

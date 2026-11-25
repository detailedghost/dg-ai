using System.Runtime.Versioning;

namespace Dg.Routing.Tests;

[SupportedOSPlatform("linux")]
[SupportedOSPlatform("macos")]
public sealed class CoreLauncherTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("dg-core-test").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string Script(string body, UnixFileMode mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute)
    {
        var path = Path.Combine(_dir, "dg-core");
        File.WriteAllText(path, $"#!/bin/sh\n{body}\n");
        File.SetUnixFileMode(path, mode);
        return path;
    }

    [Fact]
    public void Check_MissingFile_ReturnsOneLineWithReinstallCommand()
    {
        var path = Path.Combine(_dir, "dg-core");

        var line = CoreLauncher.Check(path);

        Assert.NotNull(line);
        Assert.DoesNotContain('\n', line);
        Assert.Contains(path, line);
        Assert.Contains("curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh", line);
    }

    [Fact]
    public void Check_FileWithoutExecuteBit_ReturnsOneLineWithReinstallCommand()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "the fake dg-core is a POSIX script");
        var path = Script("exit 0", UnixFileMode.UserRead | UnixFileMode.UserWrite);

        var line = CoreLauncher.Check(path);

        Assert.NotNull(line);
        Assert.DoesNotContain('\n', line);
        Assert.Contains("bootstrap.sh", line);
    }

    [Fact]
    public void Check_DirectoryAtPath_IsNotRunnable()
    {
        Directory.CreateDirectory(Path.Combine(_dir, "dg-core"));

        Assert.NotNull(CoreLauncher.Check(Path.Combine(_dir, "dg-core")));
    }

    [Fact]
    public void Check_ExecutableFile_ReturnsNull()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "the fake dg-core is a POSIX script");
        Assert.Null(CoreLauncher.Check(Script("exit 0")));
    }

    [Fact]
    public void Launch_MissingCore_ReturnsNonZeroWithoutStarting()
    {
        var launcher = new CoreLauncher(Path.Combine(_dir, "dg-core"));

        Assert.Equal(127, launcher.Launch(["spec", "validate"]));
    }

    [Fact]
    public void Launch_NonExecutableCore_Returns126()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "the fake dg-core is a POSIX script");
        var launcher = new CoreLauncher(Script("exit 0", UnixFileMode.UserRead | UnixFileMode.UserWrite));

        Assert.Equal(126, launcher.Launch([]));
    }

    [Fact]
    public void Spawn_ChildScript_ReceivesArgvAndEnvAndReturnsItsExitCode()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "the fake dg-core is a POSIX script");
        var log = Path.Combine(_dir, "log");
        var launcher = new CoreLauncher(Script($"printf '%s|' \"$@\" > '{log}'\nprintf '%s' \"$DG_ROUTING_PROBE\" >> '{log}'\nexit 7"));
        Environment.SetEnvironmentVariable("DG_ROUTING_PROBE", "probe-value");
        try
        {
            var code = launcher.Spawn(["spec", "validate", "has space", "--x=1"]);

            Assert.Equal(7, code);
            Assert.Equal("spec|validate|has space|--x=1|probe-value", File.ReadAllText(log));
        }
        finally
        {
            Environment.SetEnvironmentVariable("DG_ROUTING_PROBE", null);
        }
    }

    [Fact]
    public void BuildArgv_PathAndArgs_PlacesPathAsArgvZero()
    {
        Assert.Equal(["/x/dg-core", "a", "b c"], CoreLauncher.BuildArgv("/x/dg-core", ["a", "b c"]));
    }
}

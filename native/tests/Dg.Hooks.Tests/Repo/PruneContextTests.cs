using System.Runtime.Versioning;
using Dg.Hooks.Defs.Repo;

namespace Dg.Hooks.Tests.Repo;

public sealed class PruneContextTests
{
    [Fact]
    [SupportedOSPlatform("linux")]
    [SupportedOSPlatform("macos")]
    public void Remove_UndeletableEntry_LogsKeptAndContinues()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "unix file modes");
        Assert.SkipWhen(Environment.UserName == "root", "root ignores directory permissions");
        using var temp = TempRoot.Create();
        var locked = Path.Combine(temp.Path, "locked");
        Directory.CreateDirectory(locked);
        var stuck = Path.Combine(locked, "stuck.txt");
        File.WriteAllText(stuck, "x");
        var free = Path.Combine(temp.Path, "free.txt");
        File.WriteAllText(free, "x");
        File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserExecute);
        List<string> lines = [];
        var ctx = new PruneContext(0, false, lines.Add);

        try
        {
            ctx.Remove(stuck, "test");
            ctx.Remove(free, "test");
        }
        finally
        {
            File.SetUnixFileMode(locked, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        Assert.True(File.Exists(stuck));
        Assert.False(File.Exists(free));
        Assert.Contains(lines, line => line.StartsWith($"kept {stuck} (", StringComparison.Ordinal));
    }
}

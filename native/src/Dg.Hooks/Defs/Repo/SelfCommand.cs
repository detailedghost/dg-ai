using System.Diagnostics;

namespace Dg.Hooks.Defs.Repo;

internal static class SelfCommand
{
    public static string[] Of(params string[] args) => [Environment.ProcessPath ?? "dg", .. args];
}

internal interface IDetachedSpawner
{
    void Spawn(IReadOnlyList<string> argv);
}

internal sealed class ProcessDetachedSpawner : IDetachedSpawner
{
    private const string Silence = "exec \"$@\" </dev/null >/dev/null 2>&1";

    public void Spawn(IReadOnlyList<string> argv)
    {
        ArgumentNullException.ThrowIfNull(argv);
        ProcessStartInfo info;
        if (OperatingSystem.IsWindows())
        {
            info = new ProcessStartInfo(argv[0])
            {
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            for (var i = 1; i < argv.Count; i++)
                info.ArgumentList.Add(argv[i]);
        }
        else
        {
            var setsid = FindOnPath("setsid");
            info = new ProcessStartInfo(setsid ?? "/bin/sh");
            if (setsid is not null)
            {
                info.ArgumentList.Add("-f");
                info.ArgumentList.Add("/bin/sh");
            }
            info.ArgumentList.Add("-c");
            info.ArgumentList.Add(Silence);
            info.ArgumentList.Add("sh");
            foreach (var arg in argv)
                info.ArgumentList.Add(arg);
        }
        info.UseShellExecute = false;
        using var process =
            Process.Start(info) ?? throw new InvalidOperationException($"{argv[0]} did not start");
    }

    private static string? FindOnPath(string name)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Join(dir, name);
            if (File.Exists(candidate))
                return candidate;
        }
        return null;
    }
}

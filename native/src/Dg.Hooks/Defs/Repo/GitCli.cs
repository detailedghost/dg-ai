using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace Dg.Hooks.Defs.Repo;

internal static class GitCli
{
    public static string? Run(string cwd, params string[] args)
    {
        var info = new ProcessStartInfo("git")
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        foreach (var arg in args)
            info.ArgumentList.Add(arg);
        try
        {
            using var process = Process.Start(info);
            if (process is null)
                return null;
            var error = process.StandardError.ReadToEndAsync();
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            error.Wait();
            return process.ExitCode == 0 ? output : null;
        }
        catch (Win32Exception)
        {
            return null;
        }
    }
}

using System.Diagnostics;
using System.Runtime.InteropServices;
using Dg.Core.Output;

namespace Dg.Routing;

public sealed class CoreLauncher(string path)
{
    private const string Reinstall =
        "curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh";
    private const UnixFileMode AnyExecute =
        UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;

    public static string DefaultPath() =>
        Path.Combine(
            Path.GetDirectoryName(Environment.ProcessPath) ?? ".",
            OperatingSystem.IsWindows() ? "dg-core.exe" : "dg-core"
        );

    public static string? Check(string path)
    {
        if (!File.Exists(path))
        {
            return $"dg: dg-core not found at {path}; reinstall with: {Reinstall}";
        }
        if (!OperatingSystem.IsWindows() && (File.GetUnixFileMode(path) & AnyExecute) == 0)
        {
            return $"dg: dg-core at {path} is not executable; reinstall with: {Reinstall}";
        }
        return null;
    }

    public static string[] BuildArgv(string path, string[] args) => [path, .. args];

    public int Launch(string[] args)
    {
        if (Check(path) is { } problem)
        {
            OutputWriter.Err.WriteLine(problem);
            OutputWriter.Err.Flush();
            return File.Exists(path) ? 126 : 127;
        }
        if (OperatingSystem.IsWindows())
        {
            return Spawn(args);
        }
        Exec(args);
        var errno = Marshal.GetLastPInvokeError();
        OutputWriter.Err.WriteLine($"dg: cannot start dg-core at {path} (errno {errno}); reinstall with: {Reinstall}");
        OutputWriter.Err.Flush();
        return 126;
    }

    internal int Spawn(string[] args)
    {
        var info = new ProcessStartInfo(path) { UseShellExecute = false };
        foreach (var arg in args)
        {
            info.ArgumentList.Add(arg);
        }
        try
        {
            using var process = Process.Start(info);
            if (process is null)
            {
                return 126;
            }
            process.WaitForExit();
            return process.ExitCode;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            OutputWriter.Err.WriteLine($"dg: cannot start dg-core at {path}; reinstall with: {Reinstall}");
            OutputWriter.Err.Flush();
            return 126;
        }
    }

    private void Exec(string[] args)
    {
        var argv = BuildArgv(path, args);
        var strings = new nint[argv.Length];
        var table = Marshal.AllocHGlobal((argv.Length + 1) * nint.Size);
        try
        {
            for (var i = 0; i < argv.Length; i++)
            {
                strings[i] = Marshal.StringToCoTaskMemUTF8(argv[i]);
                Marshal.WriteIntPtr(table, i * nint.Size, strings[i]);
            }
            Marshal.WriteIntPtr(table, argv.Length * nint.Size, 0);
            execv(strings[0], table);
        }
        finally
        {
            foreach (var s in strings)
            {
                if (s != 0)
                {
                    Marshal.FreeCoTaskMem(s);
                }
            }
            Marshal.FreeHGlobal(table);
        }
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int execv(nint path, nint argv);
}

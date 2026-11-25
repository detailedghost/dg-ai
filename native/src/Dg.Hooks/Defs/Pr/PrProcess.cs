using System.Diagnostics;
using System.Text;

namespace Dg.Hooks.Defs.Pr;

internal readonly record struct ProcessResult(int Status, string Stdout);

internal static class PrProcess
{
    private const int TimeoutMs = 30_000;
    private const int CapBytes = 1024 * 1024;
    private const int TimedOutStatus = 124;
    private const int NotFoundStatus = 127;
    private const string TruncatedNote = "\n[output truncated]\n";

    public static string? Which(IReadOnlyDictionary<string, string?> env, string name)
    {
        if (!env.TryGetValue("PATH", out var path) || string.IsNullOrEmpty(path))
            return null;
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir, name);
            if (OperatingSystem.IsWindows())
            {
                foreach (var extension in (string[])[".exe", ".cmd", ".bat", ".com"])
                    if (File.Exists(candidate + extension))
                        return candidate + extension;
            }
            else if (File.Exists(candidate) && IsExecutable(candidate))
            {
                return candidate;
            }
        }
        return null;
    }

    public static async Task<ProcessResult> RunAsync(
        IReadOnlyDictionary<string, string?> env,
        string name,
        string[] args,
        string? cwd
    )
    {
        var file = Which(env, name);
        if (file is null)
            return new ProcessResult(NotFoundStatus, "");
        ProcessStartInfo info = new(file)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args)
            info.ArgumentList.Add(arg);
        if (cwd is not null)
            info.WorkingDirectory = cwd;
        info.Environment.Clear();
        foreach (var (key, value) in env)
            if (value is not null)
                info.Environment[key] = value;
        try
        {
            using var process = Process.Start(info);
            if (process is null)
                return new ProcessResult(NotFoundStatus, "");
            process.StandardInput.Close();
            var stdout = ReadCappedAsync(process.StandardOutput.BaseStream);
            var stderr = ReadCappedAsync(process.StandardError.BaseStream);
            using CancellationTokenSource timeout = new(TimeoutMs);
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
                await stderr;
                return new ProcessResult(TimedOutStatus, await stdout);
            }
            await stderr;
            return new ProcessResult(process.ExitCode, await stdout);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException or InvalidOperationException)
        {
            return new ProcessResult(NotFoundStatus, "");
        }
    }

    private static bool IsExecutable(string path) =>
        !OperatingSystem.IsWindows()
        && (File.GetUnixFileMode(path) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute))
        != UnixFileMode.None;

    private static async Task<string> ReadCappedAsync(Stream stream)
    {
        var kept = new MemoryStream();
        var buffer = new byte[16 * 1024];
        var truncated = false;
        int read;
        while ((read = await stream.ReadAsync(buffer)) > 0)
        {
            var room = CapBytes - (int)kept.Length;
            if (read > room)
                truncated = true;
            if (room > 0)
                kept.Write(buffer, 0, Math.Min(read, room));
        }
        var text = Encoding.UTF8.GetString(kept.GetBuffer(), 0, (int)kept.Length);
        return truncated ? text + TruncatedNote : text;
    }
}

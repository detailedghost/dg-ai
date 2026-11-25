using System.Diagnostics;
using System.Text;

namespace Dg.Hooks.Shared;

internal static class HookProcess
{
    private const int TimeoutMs = 30_000;
    private const int CapBytes = 1024 * 1024;
    internal const int DrainMs = 1000;
    private static readonly string[] WindowsExtensions = [".exe", ".cmd", ".bat", ".com"];
    private const string TruncatedNote = "\n[output truncated]\n";

    public static string? Which(string bin, IReadOnlyDictionary<string, string?> env)
    {
        if (bin.Contains('/', StringComparison.Ordinal))
            return IsExecutable(bin) ? bin : null;
        if (!env.TryGetValue("PATH", out var path) || string.IsNullOrEmpty(path))
            return null;
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir, bin);
            if (OperatingSystem.IsWindows())
            {
                foreach (var extension in WindowsExtensions)
                    if (File.Exists(candidate + extension))
                        return candidate + extension;
            }
            if (IsExecutable(candidate))
                return candidate;
        }
        return null;
    }

    public static async Task<CommandResult> RunAsync(
        IReadOnlyDictionary<string, string?> env,
        string[] argv,
        string? cwd,
        CancellationToken ct
    )
    {
        var program = Which(argv[0], env);
        if (program is null)
            return new CommandResult(127, "", $"Executable not found in $PATH: \"{argv[0]}\"");

        ProcessStartInfo start = new(program)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = cwd ?? "",
        };
        for (var i = 1; i < argv.Length; i++)
            start.ArgumentList.Add(argv[i]);
        start.Environment.Clear();
        foreach (var (key, value) in env)
        {
            if (value is not null)
                start.Environment[key] = value;
        }

        Process process;
        try
        {
            process = Process.Start(start) ?? throw new InvalidOperationException("process did not start");
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return new CommandResult(127, "", ex.Message);
        }

        using (process)
        {
            process.StandardInput.Close();
            using CancellationTokenSource drain = new();
            var stdout = ReadCappedAsync(process.StandardOutput.BaseStream, drain.Token);
            var stderr = ReadCappedAsync(process.StandardError.BaseStream, drain.Token);
            var timedOut = false;
            try
            {
                await process
                    .WaitForExitAsync(ct)
                    .WaitAsync(TimeSpan.FromMilliseconds(TimeoutMs), ct)
                    .ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                timedOut = true;
                Kill(process);
            }
            catch (OperationCanceledException)
            {
                Kill(process);
                await drain.CancelAsync().ConfigureAwait(false);
                throw;
            }

            try
            {
                await Task.WhenAll(stdout, stderr)
                    .WaitAsync(TimeSpan.FromMilliseconds(DrainMs), ct)
                    .ConfigureAwait(false);
            }
            catch (TimeoutException)
            {
                await drain.CancelAsync().ConfigureAwait(false);
            }

            var (outBytes, outTruncated) = await stdout.ConfigureAwait(false);
            var (errBytes, errTruncated) = await stderr.ConfigureAwait(false);
            var outText = Decode(outBytes, outTruncated);
            var errText = Decode(errBytes, errTruncated);
            return timedOut
                ? new CommandResult(
                    124,
                    outText,
                    $"{errText}{argv[0]} timed out after {TimeoutMs} ms and was killed\n",
                    outTruncated
                )
                : new CommandResult(process.ExitCode, outText, errText, outTruncated);
        }
    }

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
    }

    private static string Decode(byte[] bytes, bool truncated)
    {
        var text = Encoding.UTF8.GetString(bytes);
        return truncated ? text + TruncatedNote : text;
    }

    private static async Task<(byte[], bool)> ReadCappedAsync(Stream stream, CancellationToken ct)
    {
        using MemoryStream kept = new();
        var buffer = new byte[16 * 1024];
        var truncated = false;
        try
        {
            int read;
            while ((read = await stream.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
            {
                var room = CapBytes - (int)kept.Length;
                if (room <= 0)
                {
                    truncated = true;
                    continue;
                }
                var take = Math.Min(room, read);
                kept.Write(buffer, 0, take);
                truncated |= take < read;
            }
        }
        catch (OperationCanceledException) { }
        return (kept.ToArray(), truncated);
    }

    private static bool IsExecutable(string path)
    {
        if (!File.Exists(path))
            return false;
        if (OperatingSystem.IsWindows())
            return true;
        const UnixFileMode anyExecute = UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;
        return (File.GetUnixFileMode(path) & anyExecute) != 0;
    }
}

using Dg.Hooks.Shared;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace Dg.Hooks.Defs.Repo;

internal interface ICommandRunner
{
    ValueTask<CommandResult> RunAsync(IReadOnlyList<string> argv, string? cwd, CancellationToken ct);
}

internal sealed class ProcessCommandRunner : ICommandRunner
{
    private const int TimeoutMs = 30_000;
    private const int DrainAfterKillMs = 1_000;
    private const int CapBytes = 1024 * 1024;
    private const int TimedOutStatus = 124;
    private const int NotStartedStatus = 127;
    private const string TruncatedNote = "\n[output truncated]\n";

    public async ValueTask<CommandResult> RunAsync(
        IReadOnlyList<string> argv,
        string? cwd,
        CancellationToken ct
    )
    {
        ArgumentNullException.ThrowIfNull(argv);
        var info = new ProcessStartInfo(argv[0])
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        if (cwd is not null)
            info.WorkingDirectory = cwd;
        for (var i = 1; i < argv.Count; i++)
            info.ArgumentList.Add(argv[i]);

        Process process;
        try
        {
            process = Process.Start(info) ?? throw new InvalidOperationException($"{argv[0]} did not start");
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            return new CommandResult(NotStartedStatus, "", ex.Message);
        }

        using (process)
        {
            process.StandardInput.Close();
            var stdout = ReadCappedAsync(process.StandardOutput.BaseStream);
            var stderr = ReadCappedAsync(process.StandardError.BaseStream);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeoutMs);
            var timedOut = false;
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                Kill(process);
                ct.ThrowIfCancellationRequested();
                timedOut = true;
            }

            var drained = Task.WhenAll(stdout, stderr);
            if (timedOut)
                await Task.WhenAny(drained, Task.Delay(DrainAfterKillMs, CancellationToken.None));
            else
                await drained;

            var outText = stdout.IsCompletedSuccessfully ? stdout.Result : "";
            var errText = stderr.IsCompletedSuccessfully ? stderr.Result : "";
            return timedOut
                ? new CommandResult(
                    TimedOutStatus,
                    outText,
                    $"{errText}{argv[0]} timed out after {TimeoutMs} ms and was killed\n"
                )
                : new CommandResult(process.ExitCode, outText, errText);
        }
    }

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
    }

    private static async Task<string> ReadCappedAsync(Stream stream)
    {
        using var kept = new MemoryStream();
        var buffer = new byte[8192];
        var truncated = false;
        try
        {
            int read;
            while ((read = await stream.ReadAsync(buffer)) > 0)
            {
                var room = CapBytes - (int)kept.Length;
                if (read > room)
                {
                    truncated = true;
                    read = Math.Max(room, 0);
                }
                kept.Write(buffer, 0, read);
            }
        }
        catch (IOException) { }
        var text = Encoding.UTF8.GetString(kept.GetBuffer(), 0, (int)kept.Length);
        return truncated ? text + TruncatedNote : text;
    }
}

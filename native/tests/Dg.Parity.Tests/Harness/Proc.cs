using System.Diagnostics;
using System.Text;

namespace Dg.Parity.Tests.Harness;

internal sealed record RunResult(int Exit, byte[] StdoutBytes, byte[] StderrBytes)
{
    public string Stdout => Encoding.UTF8.GetString(StdoutBytes);

    public string Stderr => Encoding.UTF8.GetString(StderrBytes);
}

internal static class Proc
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(90);

    public static async Task<RunResult> RunAsync(
        string file,
        IEnumerable<string> args,
        IReadOnlyDictionary<string, string> env,
        string cwd,
        string? stdin,
        bool closeStdin = true,
        TimeSpan? timeout = null
    )
    {
        var info = new ProcessStartInfo(file)
        {
            WorkingDirectory = cwd,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args)
            info.ArgumentList.Add(arg);
        info.Environment.Clear();
        foreach (var (key, value) in env)
            info.Environment[key] = value;

        using var process = Process.Start(info) ?? throw new InvalidOperationException($"{file} did not start");
        var stdout = new MemoryStream();
        var stderr = new MemoryStream();
        var pumps = Task.WhenAll(
            process.StandardOutput.BaseStream.CopyToAsync(stdout),
            process.StandardError.BaseStream.CopyToAsync(stderr)
        );
        if (stdin is not null)
        {
            var bytes = new UTF8Encoding(false).GetBytes(stdin);
            try
            {
                await process.StandardInput.BaseStream.WriteAsync(bytes);
                await process.StandardInput.BaseStream.FlushAsync();
            }
            catch (IOException) { }
        }
        if (closeStdin)
            process.StandardInput.Close();

        using var limit = new CancellationTokenSource(timeout ?? DefaultTimeout);
        try
        {
            await process.WaitForExitAsync(limit.Token);
            await pumps.WaitAsync(limit.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException($"{file} {string.Join(' ', args)} did not exit in time");
        }
        return new RunResult(process.ExitCode, stdout.ToArray(), stderr.ToArray());
    }
}

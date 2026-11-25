using Dg.Hooks.Defs.Repo;

namespace Dg.Hooks.Tests.Repo;

public sealed class ProcessCommandRunnerTests
{
    private static readonly ProcessCommandRunner Runner = new();

    [Fact]
    public async Task RunAsync_Success_CapturesStdoutAndZeroStatus()
    {
        var result = await Runner.RunAsync(["git", "--version"], null, CancellationToken.None);

        Assert.Equal(0, result.Status);
        Assert.StartsWith("git version", result.Stdout);
    }

    [Fact]
    public async Task RunAsync_Failure_CapturesStderrAndStatus()
    {
        var result = await Runner.RunAsync(["git", "no-such-subcommand"], null, CancellationToken.None);

        Assert.Equal(1, result.Status);
        Assert.Contains("no-such-subcommand", result.Stderr);
    }

    [Fact]
    public async Task RunAsync_MissingExecutable_Returns127()
    {
        var result = await Runner.RunAsync(["dg-no-such-binary-46"], null, CancellationToken.None);

        Assert.Equal(127, result.Status);
        Assert.NotEqual("", result.Stderr);
    }

    [Fact]
    public async Task RunAsync_Cwd_RunsInThatDirectory()
    {
        using var dir = new TempDir();

        var result = await Runner.RunAsync(["git", "rev-parse", "--show-toplevel"], dir.Path, CancellationToken.None);

        Assert.NotEqual(0, result.Status);
        Assert.Contains("not a git repository", result.Stderr);
    }

    private sealed class TempDir : IDisposable
    {
        public string Path { get; } = Directory.CreateTempSubdirectory("dg-hooks-runner-").FullName;

        public void Dispose() => Directory.Delete(Path, recursive: true);
    }
}

using Dg.Hooks.Defs.Repo;

namespace Dg.Hooks.Tests.Repo;

[Collection(GitEnvironment.Name)]
public sealed class GitCliTests
{
    private const int MoreThanTheOutputCap = 1_100_000;

    [Fact]
    public void Run_OutputBeyondTheCap_ReturnsNull()
    {
        using var git = GitEnvironment.Isolate();
        using var repo = TempRoot.Create();
        GitCli.Run(repo.Path, "init", "-q");
        var blob = Path.Combine(repo.Path, "big.txt");
        File.WriteAllText(blob, new string('x', MoreThanTheOutputCap));
        var sha = GitCli.Run(repo.Path, "hash-object", "-w", blob)!.Trim();

        Assert.Null(GitCli.Run(repo.Path, "cat-file", "-p", sha));
    }

    [Fact]
    public void Run_OutputWithinTheCap_ReturnsTheText()
    {
        using var git = GitEnvironment.Isolate();
        using var repo = TempRoot.Create();
        GitCli.Run(repo.Path, "init", "-q");

        Assert.Equal(".git\n", GitCli.Run(repo.Path, "rev-parse", "--git-dir"));
    }
}

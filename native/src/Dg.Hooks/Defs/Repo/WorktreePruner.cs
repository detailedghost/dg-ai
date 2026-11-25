using System.Text.RegularExpressions;

namespace Dg.Hooks.Defs.Repo;

internal readonly record struct LinkedWorktree(string Path, string Branch);

internal static partial class WorktreePruner
{
    public static string[] MainReposFor(string worktreeRoot)
    {
        if (!FsPaths.Exists(worktreeRoot))
            return [];
        SortedSet<string> repos = new(StringComparer.Ordinal);
        foreach (var entry in FsPaths.ReadDirOrEmpty(worktreeRoot))
        {
            var dotGit = Path.Join(worktreeRoot, entry, ".git");
            if (!File.Exists(dotGit))
                continue;
            var gitdir = GitdirLine().Match(File.ReadAllText(dotGit));
            var common = gitdir.Success ? CommonDir().Match(gitdir.Groups[1].Value.Trim()) : Match.Empty;
            if (common.Success && FsPaths.Exists(common.Groups[1].Value))
                repos.Add(common.Groups[1].Value);
        }
        return [.. repos];
    }

    public static List<LinkedWorktree> LinkedWorktrees(string repo)
    {
        if (GitCli.Run(repo, "worktree", "list", "--porcelain") is not { Length: > 0 } output)
            return [];
        List<LinkedWorktree> found = [];
        var blocks = output.Split("\n\n");
        for (var i = 1; i < blocks.Length; i++)
        {
            var path = WorktreeLine().Match(blocks[i]);
            var branch = BranchLine().Match(blocks[i]);
            if (path.Success && branch.Success)
                found.Add(new LinkedWorktree(path.Groups[1].Value, branch.Groups[1].Value));
        }
        return found;
    }

    public static async ValueTask PruneAsync(
        string worktreeRoot,
        PruneContext ctx,
        ICommandRunner runner,
        CancellationToken ct
    )
    {
        var root = FsPaths.Exists(worktreeRoot) ? FsPaths.RealPath(worktreeRoot) : worktreeRoot;
        foreach (var repo in MainReposFor(worktreeRoot))
        {
            if (ctx.DryRun)
            {
                ctx.Log($"would check {LinkedWorktrees(repo).Count} worktree(s) in {repo}");
                continue;
            }
            var pruned = await runner.RunAsync(SelfCommand.Of("worktree", "prune"), repo, ct);
            if (pruned.Status != 0)
            {
                ctx.Log($"worktree prune failed in {repo}: {LastLine(pruned.Stderr)}");
                continue;
            }
            foreach (var worktree in LinkedWorktrees(repo))
            {
                var real = FsPaths.Exists(worktree.Path) ? FsPaths.RealPath(worktree.Path) : worktree.Path;
                if (!IsUnder(real, root))
                    continue;
                var removed = await runner.RunAsync(
                    SelfCommand.Of("worktree", "remove", worktree.Branch),
                    repo,
                    ct
                );
                ctx.Log(
                    removed.Status == 0
                        ? $"removed worktree {repo} {worktree.Branch}"
                        : $"kept worktree {repo} {worktree.Branch}: {LastLine(removed.Stderr)}"
                );
            }
        }
    }

    private static string LastLine(string stderr)
    {
        var text = stderr.Trim();
        return Ansi().Replace(text[(text.LastIndexOf('\n') + 1)..], "");
    }

    private static bool IsUnder(string child, string root)
    {
        var relative = Path.GetRelativePath(root, child);
        return relative != "."
            && relative != ".."
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !Path.IsPathRooted(relative);
    }

    [GeneratedRegex(@"^gitdir:\s*(.+)$", RegexOptions.Multiline)]
    private static partial Regex GitdirLine();

    [GeneratedRegex(@"^(.*)/\.git/worktrees/[^/]+\z")]
    private static partial Regex CommonDir();

    [GeneratedRegex(@"^worktree (.+)$", RegexOptions.Multiline)]
    private static partial Regex WorktreeLine();

    [GeneratedRegex(@"^branch refs/heads/(.+)$", RegexOptions.Multiline)]
    private static partial Regex BranchLine();

    [GeneratedRegex("\u001b\\[[0-9;]*m")]
    private static partial Regex Ansi();
}

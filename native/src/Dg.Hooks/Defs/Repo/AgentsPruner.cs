using Dg.Hooks.Shared;
namespace Dg.Hooks.Defs.Repo;

internal static class AgentsPruner
{
    private const double AgentsTtlMs = 30 * 86_400_000d;

    private static readonly string[] Keep =
    [
        ".agents/school/**",
        ".agents/references/**",
        ".agents/spec/**",
        ".agents/decisions/**",
        ".agents/monolith.md",
        ".agents/monolith/**",
        ".agents/jot/**",
        ".agents/paths.md",
        "**/HANDOFF.md",
    ];

    public static string[] ScanMainRepos(string codeRoot)
    {
        if (!FsPaths.Exists(codeRoot))
            return [];
        List<string> repos = [];
        foreach (var entry in FsPaths.ReadDirOrEmpty(codeRoot))
        {
            var dir = Path.Join(codeRoot, entry);
            if (Directory.Exists(Path.Join(dir, ".git")))
                repos.Add(dir);
        }
        return [.. repos];
    }

    public static void PruneAll(IEnumerable<string> repos, PruneContext ctx)
    {
        HashSet<string> seen = new(StringComparer.Ordinal);
        foreach (var repo in repos)
            foreach (var worktree in WorktreesOf(repo))
                if (!seen.Contains(worktree) && FsPaths.Exists(worktree))
                {
                    seen.Add(worktree);
                    PruneDir(worktree, ctx);
                }
    }

    private static List<string> WorktreesOf(string repo)
    {
        if (GitCli.Run(repo, "worktree", "list", "--porcelain") is not { } output)
            return [];
        List<string> paths = [];
        foreach (var line in output.Split('\n'))
            if (line.StartsWith("worktree ", StringComparison.Ordinal))
                paths.Add(Path.GetFullPath(line["worktree ".Length..].Trim()));
        return paths;
    }

    private static void PruneDir(string worktree, PruneContext ctx)
    {
        if (!FsPaths.Exists(Path.Join(worktree, ".agents")))
            return;
        var listing = GitCli.Run(
            worktree,
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
            ".agents"
        );
        if (string.IsNullOrEmpty(listing))
            return;
        var cutoff = ctx.NowMs - AgentsTtlMs;
        foreach (var relative in listing.Split('\0', StringSplitOptions.RemoveEmptyEntries))
        {
            var segments = relative.Split('/');
            if (
                segments[0] != ".agents"
                || Array.IndexOf(segments, ".git") >= 0
                || Array.IndexOf(segments, "..") >= 0
                || IsKept(relative)
            )
                continue;
            var path = Path.Join(worktree, relative);
            if (FsPaths.TryLstat(path) is not { } stat || stat.IsDirectory || stat.MtimeMs >= cutoff)
                continue;
            ctx.Remove(path, "ignored .agents file past TTL");
            if (!ctx.DryRun)
                RemoveEmptyDirs(worktree, Path.GetDirectoryName(path)!);
        }
    }

    private static bool IsKept(string relative)
    {
        foreach (var pattern in Keep)
            if (GlobPattern.IsMatch(pattern, relative))
                return true;
        return false;
    }

    private static void RemoveEmptyDirs(string worktree, string start)
    {
        var stop = Path.Join(worktree, ".agents");
        for (
            var dir = start;
            dir.StartsWith(stop + Path.DirectorySeparatorChar, StringComparison.Ordinal) && dir != stop;
            dir = Path.GetDirectoryName(dir)!
        )
        {
            if (
                !FsPaths.Exists(dir)
                || Directory.EnumerateFileSystemEntries(dir).Any()
                || GitCli.Run(worktree, "check-ignore", "-q", dir) is null
            )
                return;
            FsPaths.DeleteForce(dir);
        }
    }
}

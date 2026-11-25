namespace Dg.Hooks.Defs.Repo;

internal static class TtlPruner
{
    private const double DayMs = 86_400_000;
    public const double ScratchTtlMs = 14 * DayMs;
    public const double StateTtlMs = 30 * DayMs;

    private static readonly string[] Skip =
    [
        "hooks/daily-prune.stamp",
        "adhoc",
        "bg/*.pid",
        "pw/states",
        "pw/sessions",
        "pw/sock",
        "pw/log",
    ];

    public static void PruneRoot(string root, double ttlMs, bool flatFiles, PruneContext ctx)
    {
        if (!FsPaths.Exists(root))
            return;
        var cutoff = ctx.NowMs - ttlMs;
        foreach (var tool in FsPaths.ReadDirOrEmpty(root))
        {
            var toolDir = Path.Join(root, tool);
            if (Skipped(tool) || FsPaths.TryLstat(toolDir) is not { } toolStat)
                continue;
            if (!toolStat.IsDirectory)
            {
                if (flatFiles && toolStat.MtimeMs < cutoff)
                    ctx.Remove(toolDir, "flat file past TTL");
                continue;
            }
            var removed = 0;
            foreach (var entry in FsPaths.ReadDirOrEmpty(toolDir))
            {
                var path = Path.Join(toolDir, entry);
                if (
                    Skipped($"{tool}/{entry}")
                    || FsPaths.TryLstat(path) is null
                    || NewestMtime(path, cutoff) >= cutoff
                )
                    continue;
                ctx.Remove(path, IsBucket(entry) ? "bucket past TTL" : "global entry past TTL");
                removed++;
            }
            if (removed > 0 && !ctx.DryRun && FsPaths.ReadDirOrEmpty(toolDir).Length == 0)
                ctx.Remove(toolDir, "empty tool dir");
        }
    }

    private static double NewestMtime(string path, double cutoff)
    {
        if (FsPaths.TryLstat(path) is not { } stat)
            return 0;
        if (!stat.IsDirectory || stat.MtimeMs >= cutoff)
            return stat.MtimeMs;
        var newest = stat.MtimeMs;
        foreach (var child in FsPaths.ReadDirOrEmpty(path))
        {
            newest = Math.Max(newest, NewestMtime(Path.Join(path, child), cutoff));
            if (newest >= cutoff)
                return newest;
        }
        return newest;
    }

    private static bool Skipped(string relative)
    {
        foreach (var pattern in Skip)
            if (GlobPattern.IsMatch(pattern, relative))
                return true;
        return false;
    }

    private static bool IsBucket(string name)
    {
        if (name.Length != 8)
            return false;
        foreach (var c in name)
            if (c is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
                return false;
        return true;
    }
}

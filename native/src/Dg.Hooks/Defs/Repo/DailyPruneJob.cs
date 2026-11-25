using System.Globalization;

namespace Dg.Hooks.Defs.Repo;

internal sealed class DailyPruneJob(
    Func<string, string?> env,
    string home,
    ICommandRunner runner,
    TimeProvider time,
    TextWriter output
)
{
    public async ValueTask RunAsync(bool dryRun, CancellationToken ct)
    {
        List<string> lines = [];
        var now = time.GetUtcNow();
        var ctx = new PruneContext(
            now.ToUnixTimeMilliseconds(),
            dryRun,
            line =>
            {
                lines.Add(line);
                output.Write($"{line}\n");
            }
        );
        ctx.Log(
            $"daily-prune {now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)}{(dryRun ? " dry-run" : "")}"
        );

        var codeRoot = env("DAILY_PRUNE_CODE_ROOT");
        var worktreeRoot =
            env("DAILY_PRUNE_WORKTREE_ROOT")
            ?? Path.Join(codeRoot ?? Path.Join(home, "code"), "worktrees");
        var scratch = ManagedRoots.Scratch(env);

        await Phase(
            ctx,
            "scratch prune",
            () =>
            {
                ManagedRoots.AssertSafe(scratch, ManagedRoots.IsSet(env, "AI_SCRATCH_DIR"));
                TtlPruner.PruneRoot(scratch, TtlPruner.ScratchTtlMs, true, ctx);
                return ValueTask.CompletedTask;
            }
        );
        await Phase(
            ctx,
            "state prune",
            () =>
            {
                var state = ManagedRoots.State(env, home);
                ManagedRoots.AssertSafe(state, ManagedRoots.IsSet(env, "AI_STATE_DIR"));
                TtlPruner.PruneRoot(state, TtlPruner.StateTtlMs, false, ctx);
                return ValueTask.CompletedTask;
            }
        );
        await Phase(ctx, "worktree prune", () => WorktreePruner.PruneAsync(worktreeRoot, ctx, runner, ct));
        await Phase(
            ctx,
            "agents prune",
            () =>
            {
                SortedSet<string> repos = new(WorktreePruner.MainReposFor(worktreeRoot), StringComparer.Ordinal);
                if (!string.IsNullOrEmpty(codeRoot))
                    repos.UnionWith(AgentsPruner.ScanMainRepos(codeRoot));
                AgentsPruner.PruneAll(repos, ctx);
                return ValueTask.CompletedTask;
            }
        );

        if (dryRun)
            return;
        var logDir = Path.Join(scratch, "hooks");
        Directory.CreateDirectory(logDir);
        await File.WriteAllTextAsync(Path.Join(logDir, "daily-prune.log"), $"{string.Join('\n', lines)}\n", ct);
    }

    private static async ValueTask Phase(PruneContext ctx, string name, Func<ValueTask> work)
    {
        try
        {
            await work();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            ctx.Log($"{name} failed: {ex.Message}");
        }
    }
}

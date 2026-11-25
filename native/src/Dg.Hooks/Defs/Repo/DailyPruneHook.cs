using Dg.Hooks.Engine;

namespace Dg.Hooks.Defs.Repo;

internal sealed class DailyPruneHook(
    Func<string, string?> env,
    string home,
    ICommandRunner runner,
    IDetachedSpawner spawner,
    TimeProvider time,
    TextWriter output,
    TextWriter error
) : IHook
{
    private const double DayMs = 86_400_000;

    public string Id => "daily-prune";

    public async ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
    {
        var now = Array.IndexOf(ev.Args, "--now") >= 0;
        var dryRun = Array.IndexOf(ev.Args, "--dry-run") >= 0;
        if (dryRun && !now)
        {
            await error.WriteAsync("hooks run daily-prune: --dry-run requires --now\n");
            return 2;
        }
        if (now)
        {
            await new DailyPruneJob(env, home, runner, time, output).RunAsync(dryRun, ct);
            return 0;
        }
        SpawnOncePerDay();
        return 0;
    }

    private void SpawnOncePerDay()
    {
        ManagedRoots.PrivateChild(ManagedRoots.Scratch(env), "hooks", ManagedRoots.IsSet(env, "AI_SCRATCH_DIR"));
        var stateDir = ManagedRoots.PrivateChild(
            ManagedRoots.State(env, home),
            "hooks",
            ManagedRoots.IsSet(env, "AI_STATE_DIR")
        );
        var stamp = Path.Join(stateDir, "daily-prune.stamp");
        if (StampFresh(stamp))
            return;
        var lockPath = $"{stamp}.lock";
        if (PruneLock.Take(lockPath, time) is not { } token)
            return;
        try
        {
            if (StampFresh(stamp))
                return;
            DateTime? previous = File.Exists(stamp) ? File.GetLastWriteTimeUtc(stamp) : null;
            WriteStamp(stamp);
            try
            {
                spawner.Spawn(SelfCommand.Of("hooks", "run", "daily-prune", "--now"));
            }
            catch
            {
                if (previous is { } restored)
                    File.SetLastWriteTimeUtc(stamp, restored);
                else
                    File.Delete(stamp);
                throw;
            }
        }
        finally
        {
            PruneLock.Release(lockPath, token);
        }
    }

    private bool StampFresh(string stamp) =>
        File.Exists(stamp) && (time.GetUtcNow() - File.GetLastWriteTimeUtc(stamp)).TotalMilliseconds < DayMs;

    private static void WriteStamp(string stamp)
    {
        var temp = $"{stamp}.{Environment.ProcessId}.{Guid.NewGuid()}.tmp";
        try
        {
            File.WriteAllBytes(temp, []);
            File.Move(temp, stamp, overwrite: true);
        }
        catch
        {
            File.Delete(temp);
            throw;
        }
    }
}

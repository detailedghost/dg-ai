namespace Dg.Hooks.Defs.Repo;

internal sealed class PruneContext(double nowMs, bool dryRun, Action<string> log)
{
    public double NowMs => nowMs;

    public bool DryRun => dryRun;

    public void Log(string line) => log(line);

    public void Remove(string path, string reason)
    {
        log($"{(dryRun ? "would remove" : "removed")} {path} ({reason})");
        if (!dryRun)
            FsPaths.DeleteForce(path);
    }
}

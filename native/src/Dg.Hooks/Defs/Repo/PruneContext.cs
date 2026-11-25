using Dg.Hooks.Shared;
namespace Dg.Hooks.Defs.Repo;

internal sealed class PruneContext(double nowMs, bool dryRun, Action<string> log)
{
    public double NowMs => nowMs;

    public bool DryRun => dryRun;

    public void Log(string line) => log(line);

    public void Remove(string path, string reason)
    {
        log($"{(dryRun ? "would remove" : "removed")} {path} ({reason})");
        if (dryRun)
            return;
        try
        {
            FsPaths.DeleteForce(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log($"kept {path} ({ex.Message})");
        }
    }
}

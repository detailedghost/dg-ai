using Dg.Hooks.Shared;
namespace Dg.Hooks.Defs.Repo;

internal sealed class PruneContext(double nowMs, bool dryRun, Action<string> log)
{
    public double NowMs => nowMs;

    public bool DryRun => dryRun;

    public void Log(string line) => log(line);

    public void Remove(string path, string reason)
    {
        if (dryRun)
        {
            log($"would remove {path} ({reason})");
            return;
        }
        try
        {
            FsPaths.DeleteForce(path);
            log($"removed {path} ({reason})");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            log($"kept {path} ({ex.Message})");
        }
    }
}

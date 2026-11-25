using Dg.Hooks.Shared;

namespace Dg.Hooks.Defs.Repo;

internal static class GitCli
{
    public static string? Run(string cwd, params string[] args)
    {
        var result = HookProcess
            .RunAsync(HookEnvironment.Process().Values, ["git", .. args], cwd, CancellationToken.None)
            .GetAwaiter()
            .GetResult();
        return result.Status == 0 ? result.Stdout : null;
    }
}

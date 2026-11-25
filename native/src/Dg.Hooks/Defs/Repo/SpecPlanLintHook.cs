using Dg.Hooks.Shared;
using System.Text.RegularExpressions;
using Dg.Hooks.Engine;

namespace Dg.Hooks.Defs.Repo;

internal sealed partial class SpecPlanLintHook(ICommandRunner runner, TextWriter error) : IHook
{
    private static readonly string[] Checks = ["validate", "lint-waves"];

    public string Id => "spec-plan-lint";

    public async ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
    {
        var file = ev.ResponseFilePath ?? ev.FilePath ?? "";
        if (!PlanPath().IsMatch(file.Replace('\\', '/')))
            return 0;
        var cwd = ev.Cwd ?? Directory.GetCurrentDirectory();
        var pending = new Task<CommandResult>[Checks.Length];
        for (var i = 0; i < Checks.Length; i++)
            pending[i] = runner.RunAsync(SelfCommand.Of("spec", Checks[i], file), cwd, ct).AsTask();
        var results = await Task.WhenAll(pending);

        List<string> failures = [];
        for (var i = 0; i < results.Length; i++)
            if (results[i].Status != 0)
                failures.Add(
                    $"spec {Checks[i]} failed (exit {results[i].Status}):\n{(results[i].Stdout + results[i].Stderr).Trim()}"
                );
        if (failures.Count == 0)
            return 0;
        await error.WriteAsync($"{file}\n{string.Join("\n\n", failures)}\n");
        return 2;
    }

    [GeneratedRegex(@"\.agents/spec/(?:todo/)?[^/]+/plan\.md\z")]
    private static partial Regex PlanPath();
}

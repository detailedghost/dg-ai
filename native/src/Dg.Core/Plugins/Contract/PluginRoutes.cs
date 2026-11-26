using System.Collections.Frozen;

namespace Dg.Core.Plugins.Contract;

public static class PluginRoutes
{
    public const string Hello = "/v1/hello";
    public const string HookDecide = "/v1/hook/decide";
    public const string JobRun = "/v1/job/run";
    public const string JobStatus = "/v1/job/status";
    public const string SkillDescribe = "/v1/skill/describe";
    public const string Health = "/v1/health";

    public static IReadOnlyList<string> All { get; } =
        [Hello, HookDecide, JobRun, JobStatus, SkillDescribe, Health];

    private static readonly FrozenSet<string> Known = FrozenSet.ToFrozenSet(All, StringComparer.Ordinal);

    public static (int Ipc, int Tcp, int Http) HookLatencyBudgetP99Ms { get; } = (1, 2, 5);

    public static bool IsKnown(string route) => Known.Contains(route);

    public static TimeSpan TimeoutFor(string route) =>
        route switch
        {
            Hello or Health => TimeSpan.FromSeconds(1),
            HookDecide or JobStatus or SkillDescribe => TimeSpan.FromSeconds(2),
            JobRun => TimeSpan.FromSeconds(10),
            _ => throw MessageValidator.UnknownRoute(route),
        };

    public static string TokenCredential(string plugin) => $"plugin-{plugin}-token";
}

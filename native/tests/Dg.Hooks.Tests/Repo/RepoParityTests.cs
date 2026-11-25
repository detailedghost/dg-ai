using System.Text;
using System.Text.RegularExpressions;
using Dg.Hooks.Defs.Repo;
using Dg.Hooks.Engine;
using Dg.Hooks.Shared;

namespace Dg.Hooks.Tests.Repo;

[Collection(GitEnvironment.Name)]
public sealed partial class RepoParityTests : IDisposable
{
    private const string DefaultStdin = """{"hook_event_name":"SessionStart"}""";

    private readonly GitEnvironment _git = GitEnvironment.Isolate();

    public void Dispose() => _git.Dispose();

    public static TheoryData<string> LintNames => FixtureCases.Names("lint-");

    public static TheoryData<string> GateNames => FixtureCases.Names("gate-");

    public static TheoryData<string> PruneNames => FixtureCases.Names("prune-");

    private sealed class ScriptedRunner(List<RunnerRule> rules, List<string> calls, string root) : ICommandRunner
    {
        public ValueTask<CommandResult> RunAsync(IReadOnlyList<string> argv, string? cwd, CancellationToken ct)
        {
            var tail = Tail(argv, "spec", "worktree");
            lock (calls)
                calls.Add(Normalize($"call: {string.Join(' ', tail)} (cwd={cwd ?? ""})", root));
            var rule = rules.Find(r => r.Match.Select((m, i) => i < tail.Length && tail[i] == m).All(x => x));
            return ValueTask.FromResult(new CommandResult(rule?.Status ?? 0, rule?.Stdout ?? "", rule?.Stderr ?? ""));
        }
    }

    private sealed class RecordingSpawner(bool throws, List<string> calls) : IDetachedSpawner
    {
        public void Spawn(IReadOnlyList<string> argv)
        {
            calls.Add($"spawn: {string.Join(' ', Tail(argv, "hooks"))}");
            if (throws)
                throw new InvalidOperationException("spawn failed");
        }
    }

    [Theory]
    [MemberData(nameof(LintNames))]
    public async Task SpecPlanLint_Fixture_MatchesBunOutputAndExitCode(string name) =>
        Assert.Equal(FixtureCases.Expected(name), await RunCase(name));

    [Theory]
    [MemberData(nameof(GateNames))]
    public async Task DailyPruneGate_Fixture_MatchesBunOutputAndExitCode(string name) =>
        Assert.Equal(FixtureCases.Expected(name), await RunCase(name));

    [Theory]
    [MemberData(nameof(PruneNames))]
    public async Task DailyPruneNow_Fixture_PrunesSamePathsAsBun(string name)
    {
        if (FixtureCases.Load(name).Entries?.Any(e => e.Kind == "symlink" && e.AgeDays > 0) == true)
            Assert.SkipUnless(OperatingSystem.IsLinux(), "aging a symlink needs GNU touch -h");
        Assert.Equal(FixtureCases.Expected(name), await RunCase(name));
    }

    private static string[] Tail(IReadOnlyList<string> argv, params string[] anchors)
    {
        for (var i = 1; i < argv.Count; i++)
            if (Array.IndexOf(anchors, argv[i]) >= 0)
                return [.. argv.Skip(i)];
        return [];
    }

    private static string Normalize(string text, string root) =>
        text.Replace(root, "<ROOT>", StringComparison.Ordinal);

    private static string LogSection(IEnumerable<string> lines, string root)
    {
        var all = lines.Select(l => Normalize(l, root)).ToList();
        if (all.Count == 0)
            return "";
        var head = HeaderPattern().Replace(all[0], "daily-prune <NOW>");
        var body = all.Skip(1).ToList();
        body.Sort(StringComparer.Ordinal);
        return string.Join('\n', [head, .. body]) + "\n";
    }

    private static async Task<string> RunCase(string name)
    {
        var c = FixtureCases.Load(name);
        using var layout = FixtureLayout.Build(c);
        var root = layout.Root;
        Dictionary<string, string?> env = new()
        {
            ["HOME"] = layout.Join("home"),
            ["DG_PATH_FENCE"] = root,
            ["AI_SCRATCH_DIR"] = layout.Join("scratch"),
            ["AI_STATE_DIR"] = layout.Join("state"),
            ["DAILY_PRUNE_CODE_ROOT"] = layout.Join("code"),
            ["DAILY_PRUNE_WORKTREE_ROOT"] = layout.Join("code", "worktrees"),
        };
        foreach (var (key, value) in c.Env ?? [])
            env[key] = value?.Replace("<ROOT>", root, StringComparison.Ordinal);

        var before = layout.Tree();
        List<string> calls = [];
        var runner = new ScriptedRunner(c.Runner ?? [], calls, root);
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        IHook hook = c.Hook == "spec-plan-lint"
            ? new SpecPlanLintHook(runner, stderr)
            : new DailyPruneHook(
                key => env.GetValueOrDefault(key),
                layout.Join("home"),
                runner,
                new RecordingSpawner(c.SpawnThrows, calls),
                TimeProvider.System,
                stdout,
                stderr
            );
        var args = c.Args ?? [];
        var stdin = new MemoryStream(Encoding.UTF8.GetBytes(c.Stdin?.GetRawText() ?? DefaultStdin));

        var exit = await new HookEngine([hook], stderr).RunAsync(c.Hook, args, stdin, CancellationToken.None);

        var isNow = c.Hook == "daily-prune" && args.Contains("--now");
        List<(string Key, string Value)> sections =
        [
            ("exit", $"{exit}\n"),
            ("stdout", isNow ? "" : Normalize(stdout.ToString(), root)),
            ("stderr", Normalize(stderr.ToString(), root)),
        ];
        calls.Sort(StringComparer.Ordinal);
        sections.Add(("calls", calls.Count == 0 ? "" : string.Join('\n', calls) + "\n"));
        if (c.Hook == "daily-prune")
        {
            var stamp = layout.Join("state", "hooks", "daily-prune.stamp");
            var age = File.Exists(stamp)
                ? $"{Math.Round((DateTime.UtcNow - File.GetLastWriteTimeUtc(stamp)).TotalDays, MidpointRounding.AwayFromZero)} days"
                : "absent";
            sections.Add(("stamp", $"{age}\n"));
            if (isNow)
            {
                sections.Add(("log", LogSection(stdout.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries), root)));
                var logFile = layout.Join("scratch", "hooks", "daily-prune.log");
                sections.Add((
                    "logfile",
                    File.Exists(logFile)
                        ? LogSection(File.ReadAllText(logFile).TrimEnd().Split('\n'), root)
                        : ""
                ));
            }
            var after = layout.Tree();
            sections.Add(("tree", string.Join('\n', after) + "\n"));
            var gone = before.Where(p => !after.Contains(p)).ToList();
            sections.Add(("pruned", gone.Count == 0 ? "" : string.Join('\n', gone) + "\n"));
        }
        return string.Concat(sections.Select(s => $"--- {s.Key}\n{s.Value}"));
    }

    [GeneratedRegex(@"^daily-prune \S+")]
    private static partial Regex HeaderPattern();
}

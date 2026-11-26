using Dg.Parity.Tests.Harness;

namespace Dg.Parity.Tests;

public sealed class FrontDoorTests
{
    private const string Version = "9.9.9-front";

    private static readonly string[][] EveryCommand =
    [
        ["--version"],
        ["__complete", "stat", "ch"],
        ["hooks", "run", "pr-confirm"],
        ["config", "get", "front.enabled"],
        ["plugin", "list"],
        ["spec", "validate", "plan.md"],
    ];

    public static TheoryData<string> EveryCommandNames()
    {
        var data = new TheoryData<string>();
        foreach (var argv in EveryCommand)
            data.Add(string.Join(' ', argv));
        return data;
    }

    [Fact]
    public async Task Run_DefaultWithoutOptOut_RunsNatively()
    {
        var run = await Front(["--version"], env: Versioned());

        Assert.Equal($"{Version}\n", run.Stdout);
        Assert.Equal("", run.Stderr);
        Assert.Equal(0, run.Exit);
    }

    [Theory]
    [MemberData(nameof(EveryCommandNames))]
    public async Task Run_DgFrontZero_ExecsCoreWithOriginalArgv(string command)
    {
        var argv = command.Split(' ');

        var run = await Front(argv, stdin: "payload", env: Versioned(("DG_FRONT", "0")));

        Assert.Equal($"core argv:{string.Concat(argv.Select(a => $" [{a}]"))}\ncore stdin:payload\n", run.Stdout);
        Assert.Equal(0, run.Exit);
    }

    [Theory]
    [MemberData(nameof(EveryCommandNames))]
    public async Task Run_ConfigFrontDisabled_ExecsCoreWithOriginalArgv(string command)
    {
        var argv = command.Split(' ');

        var run = await Front(argv, config: "[front]\nenabled = false\n", stdin: "payload", env: Versioned());

        Assert.Equal($"core argv:{string.Concat(argv.Select(a => $" [{a}]"))}\ncore stdin:payload\n", run.Stdout);
    }

    [Fact]
    public async Task Run_DgFrontOneWithConfigDisabled_RunsNatively()
    {
        var run = await Front(["--version"], config: "[front]\nenabled = false\n", env: Versioned(("DG_FRONT", "1")));

        Assert.Equal($"{Version}\n", run.Stdout);
    }

    [Fact]
    public async Task Run_ConfigFrontEnabledTrue_RunsNatively()
    {
        var run = await Front(["--version"], config: "[front]\nenabled = true\n", env: Versioned());

        Assert.Equal($"{Version}\n", run.Stdout);
    }

    [Theory]
    [InlineData("[pw\nmode = \"ext\"\n")]
    [InlineData("[pw]\nmode = \"loud\"\n")]
    public async Task Run_ConfigDoesNotLoad_ExecsCore(string config)
    {
        var run = await Front(["--version"], config: config, env: Versioned());

        Assert.Equal("core argv: [--version]\ncore stdin:\n", run.Stdout);
    }

    [Fact]
    public async Task Run_CoreMissingAndOptedOut_PrintsOneReinstallLineAndExits127()
    {
        var run = await Front(["spec", "validate"], env: Versioned(("DG_FRONT", "0")), core: false);

        Assert.Equal(127, run.Exit);
        Assert.Equal("", run.Stdout);
        var lines = run.Stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        var line = Assert.Single(lines);
        Assert.Contains("dg-core", line);
        Assert.Contains("reinstall with:", line);
    }

    [Fact]
    public async Task Run_CoreMissingForCoreCommand_PrintsOneReinstallLineAndExits127()
    {
        var run = await Front(["spec", "validate"], env: Versioned(), core: false);

        Assert.Equal(127, run.Exit);
        Assert.Single(run.Stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries));
    }

    [Fact]
    public async Task Run_CoreMissingForNativeCommand_StillRunsNatively()
    {
        var run = await Front(["--version"], env: Versioned(), core: false);

        Assert.Equal($"{Version}\n", run.Stdout);
        Assert.Equal(0, run.Exit);
    }

    [Theory]
    [InlineData("spec|validate|--strict|plan.md")]
    [InlineData("spec|validate|a b||é")]
    [InlineData("hooks|list")]
    [InlineData("hooks|run|no-such-hook|--flag")]
    [InlineData("hooks|run")]
    [InlineData("plugin|add|./x")]
    [InlineData("config|get")]
    [InlineData("config|set|plugins.x.settings.token|--credential|x-token")]
    [InlineData("help")]
    public async Task Run_CoreOrNotNativeCommand_ReachesCoreWithArgvUnchanged(string joined)
    {
        var argv = joined.Split('|');

        var run = await Front(argv, stdin: "in", env: Versioned());

        Assert.Equal($"core argv:{string.Concat(argv.Select(a => $" [{a}]"))}\ncore stdin:in\n", run.Stdout);
        Assert.Equal("", run.Stderr);
    }

    [Fact]
    public async Task Run_CoreCommand_PropagatesCoreExitCode()
    {
        var run = await Front(["spec", "validate"], env: Versioned(("DG_PARITY_EXIT", "7")));

        Assert.Equal(7, run.Exit);
    }

    [Fact]
    public async Task Run_StripAiCoauthorsWithOpenStdin_ReturnsWithoutWaitingForEof()
    {
        var run = await Front(
            ["hooks", "run", "strip-ai-coauthors"],
            stdin: "",
            env: Versioned(),
            closeStdin: false,
            timeout: TimeSpan.FromSeconds(20)
        );

        Assert.Equal(2, run.Exit);
        Assert.Equal("hooks run strip-ai-coauthors: needs the commit message file\n", run.Stderr);
    }

    private static (string, string)[] Versioned(params (string, string)[] extra) =>
        [("DG_BUILD_VERSION", Version), .. extra];

    private static async Task<RunResult> Front(
        string[] argv,
        string? config = null,
        string? stdin = "",
        (string, string)[]? env = null,
        bool core = true,
        bool closeStdin = true,
        TimeSpan? timeout = null
    )
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "the fake dg-core is a POSIX script");
        var host = FrontDoorHost.Shared;
        using var sandbox = new Sandbox();
        var entry = new ParityCase(
            "front",
            argv,
            Config: config,
            Env: (env ?? []).ToDictionary(static e => e.Item1, static e => e.Item2)
        );
        sandbox.Materialize(entry);
        return await Proc.RunAsync(
            core ? host.WithCore : host.WithoutCore,
            argv,
            sandbox.Env(entry, host, "echo"),
            sandbox.WorkingDirectory(entry),
            stdin,
            closeStdin,
            timeout
        );
    }
}

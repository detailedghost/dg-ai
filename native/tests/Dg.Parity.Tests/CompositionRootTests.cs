using Dg.Cli;
using Dg.Config;
using Dg.Core.Abstractions;
using Dg.Core.Config;
using Dg.Core.Credentials;
using Dg.Core.Paths;
using Dg.Core.Plugins.Runtime;
using Dg.Hooks.Engine;
using Dg.Plugins;
using Dg.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Parity.Tests;

public sealed class CompositionRootTests : IDisposable
{
    private readonly string _home = Directory.CreateTempSubdirectory("dg-compose-").FullName;

    public void Dispose() => Directory.Delete(_home, recursive: true);

    public static TheoryData<string, string> NativeCommands =>
        new()
        {
            { "--version", "--version" },
            { "__complete st ch", "__complete" },
            { "hooks run pr-confirm", "hooks run" },
            { "config get browser.mode", "config get" },
            { "config set browser.mode ext", "config set" },
            { "config list", "config list" },
            { "config doctor", "config doctor" },
            { "plugin list", "plugin list" },
            { "plugin verify x", "plugin verify" },
        };

    [Theory]
    [MemberData(nameof(NativeCommands))]
    public void Resolve_StageOneCommand_IsNative(string argv, string name)
    {
        using var provider = CompositionRoot.Build(Env(), toml: null);

        var target = provider.GetRequiredService<Route>().Resolve(argv.Split(' '));

        Assert.Equal(name, Assert.IsType<Route.Native>(target).Command.Name);
    }

    [Theory]
    [InlineData("spec validate plan.md")]
    [InlineData("hooks list")]
    [InlineData("plugin add ./x")]
    [InlineData("stat")]
    [InlineData("--help")]
    [InlineData("")]
    public void Resolve_EverythingElse_IsCoreWithArgvUnchanged(string argv)
    {
        using var provider = CompositionRoot.Build(Env(), toml: null);
        var words = argv.Split(' ', StringSplitOptions.RemoveEmptyEntries);

        var target = provider.GetRequiredService<Route>().Resolve(words);

        Assert.Equal(words, Assert.IsType<Route.Core>(target).Argv);
    }

    [Fact]
    public void Build_BadPathsAndNoToml_DoesNotThrowUntilPathsAreNeeded()
    {
        var env = Env(("DG_PATH_FENCE", Path.Combine(_home, "inside")));

        using var provider = CompositionRoot.Build(env, toml: null);

        Assert.NotNull(provider.GetRequiredService<Route>());
    }

    [Fact]
    public async Task Build_PluginsRuntime_ResolvesHostFromRootPieces()
    {
        var toml = DgConfig.Parse("", "config.toml").Value!;
        using var provider = CompositionRoot.Build(Env(), toml);

        Assert.NotNull(provider.GetRequiredService<IPluginHost>());
        Assert.Same(toml, provider.GetRequiredService<DgToml>());
        Assert.StartsWith(_home, provider.GetRequiredService<DgPaths>().ConfigTomlPath);
        Assert.Null(await provider.GetRequiredService<ICredentialStore>().GetAsync("any", CancellationToken.None));
    }

    [Fact]
    public void NotNative_Sentinel_MatchesEveryGroup()
    {
        Assert.Equal(ConfigExit.NotNative, CliExit.NotNative);
        Assert.Equal(PluginsExit.NotNative, CliExit.NotNative);
    }

    [Fact]
    public async Task HooksRun_UnknownId_IsNotNativeAndTouchesNoEngine()
    {
        var command = new HooksRunCommand(
            () => throw new InvalidOperationException("engine must stay unbuilt"),
            () => []
        );

        var exit = await command.RunAsync(new[] { "no-such-hook", "--flag" }, CancellationToken.None);

        Assert.Equal(CliExit.NotNative, exit);
    }

    [Fact]
    public async Task HooksRun_NoId_IsNotNative()
    {
        var command = new HooksRunCommand(
            () => throw new InvalidOperationException("engine must stay unbuilt"),
            () => []
        );

        Assert.Equal(CliExit.NotNative, await command.RunAsync(Array.Empty<string>(), CancellationToken.None));
    }

    [Fact]
    public async Task HooksRun_BuiltInId_RunsThroughTheEngine()
    {
        var hook = new RecordingHook("probe");
        var command = new HooksRunCommand(() => new HookEngine([hook], TextWriter.Null), () => [hook]);

        var exit = await command.RunAsync(new[] { "probe", "--x" }, CancellationToken.None);

        Assert.Equal(7, exit);
        Assert.Equal(["--x"], hook.Args);
    }

    [Fact]
    public async Task Complete_FewerThanTwoWords_IsNotNative()
    {
        var inner = new FakeCommand("__complete", 0);
        var gate = new CompleteGateCommand(inner);

        Assert.Equal(CliExit.NotNative, await gate.RunAsync(Array.Empty<string>(), CancellationToken.None));
        Assert.Equal(CliExit.NotNative, await gate.RunAsync(new[] { "st" }, CancellationToken.None));
        Assert.Equal(0, inner.Calls);
    }

    [Fact]
    public async Task Complete_TwoWords_RunsTheCompletion()
    {
        var inner = new FakeCommand("__complete", 0);
        var gate = new CompleteGateCommand(inner);

        Assert.Equal(0, await gate.RunAsync(new[] { "stat", "ch" }, CancellationToken.None));
        Assert.Equal(1, inner.Calls);
        Assert.Equal("__complete", gate.Name);
    }

    private Dictionary<string, string?> Env(params (string Key, string Value)[] extra)
    {
        Dictionary<string, string?> env = new(StringComparer.Ordinal)
        {
            ["DG_HOME"] = _home,
            ["DG_PATH_FENCE"] = _home,
            ["HOME"] = _home,
        };
        foreach (var (key, value) in extra)
            env[key] = value;
        return env;
    }

    private sealed class FakeCommand(string name, int exit) : ICommand
    {
        public int Calls { get; private set; }

        public string Name => name;

        public ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct)
        {
            Calls++;
            return ValueTask.FromResult(exit);
        }
    }

    private sealed class RecordingHook(string id) : IHook
    {
        public string[] Args { get; private set; } = [];

        public string Id => id;

        public bool UsesStdin(string[] args) => false;

        public ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
        {
            Args = ev.Args;
            return ValueTask.FromResult(7);
        }
    }
}

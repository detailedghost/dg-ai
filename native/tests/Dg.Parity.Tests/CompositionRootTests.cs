using Dg.Cli;
using Dg.Config;
using Dg.Core.Abstractions;
using Dg.Core.Errors;
using Dg.Hooks.Engine;
using Dg.Plugins;
using Dg.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Parity.Tests;

public sealed class CompositionRootTests
{
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
            { "plugin enable x", "plugin enable" },
            { "plugin disable x", "plugin disable" },
        };

    [Theory]
    [MemberData(nameof(NativeCommands))]
    public void Resolve_StageOneCommand_IsNative(string argv, string name)
    {
        using var provider = CompositionRoot.Build();

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
        using var provider = CompositionRoot.Build();
        var words = argv.Split(' ', StringSplitOptions.RemoveEmptyEntries);

        var target = provider.GetRequiredService<Route>().Resolve(words);

        Assert.Equal(words, Assert.IsType<Route.Core>(target).Argv);
    }

    [Fact]
    public void Commands_AfterComposition_HaveUniqueNonEmptyNames()
    {
        using var provider = CompositionRoot.Build();

        var names = provider.GetServices<ICommand>().Select(static c => c.Name).ToArray();

        Assert.All(names, static name => Assert.False(string.IsNullOrWhiteSpace(name)));
        Assert.Equal(names.Length, names.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public async Task HooksRun_UnknownId_IsNotNativeAndTouchesNoEngine()
    {
        var command = new HooksRunCommand(
            () => throw new InvalidOperationException("engine must stay unbuilt"),
            () => []
        );

        var exit = await command.RunAsync(new[] { "no-such-hook", "--flag" }, CancellationToken.None);

        Assert.Equal(ExitCodes.NotNative, exit);
    }

    [Fact]
    public async Task HooksRun_NoId_IsNotNative()
    {
        var command = new HooksRunCommand(
            () => throw new InvalidOperationException("engine must stay unbuilt"),
            () => []
        );

        Assert.Equal(ExitCodes.NotNative, await command.RunAsync(Array.Empty<string>(), CancellationToken.None));
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

        Assert.Equal(ExitCodes.NotNative, await gate.RunAsync(Array.Empty<string>(), CancellationToken.None));
        Assert.Equal(ExitCodes.NotNative, await gate.RunAsync(new[] { "st" }, CancellationToken.None));
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

    [Theory]
    [MemberData(nameof(CommandFailures))]
    public async Task RunNative_CommandThrowsIoFailure_ReturnsOneInsteadOfCrashing(Exception failure)
    {
        var exit = await FrontDoor.RunNativeAsync(new ThrowingCommand(failure), Array.Empty<string>(), CancellationToken.None);

        Assert.Equal(1, exit);
    }

    [Fact]
    public async Task RunNative_CommandThrowsUnexpectedException_Propagates()
    {
        var command = new ThrowingCommand(new InvalidOperationException("bug"));

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await FrontDoor.RunNativeAsync(command, Array.Empty<string>(), CancellationToken.None)
        );
    }

    public static TheoryData<Exception> CommandFailures =>
        new()
        {
            new IOException("disk"),
            new UnauthorizedAccessException("denied"),
            new DgError("f", 1, "k", "bad", "fix").ToException(),
        };

    private sealed class ThrowingCommand(Exception failure) : ICommand
    {
        public string Name => "throws";

        public ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct) => throw failure;
    }
}

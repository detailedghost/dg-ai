using Dg.Core.Abstractions;

namespace Dg.Routing.Tests;

public sealed class RouteTests
{
    private sealed class Stub(string name) : ICommand
    {
        public string Name { get; } = name;

        public ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct) => ValueTask.FromResult(0);
    }

    [Fact]
    public void Resolve_SingleWordNativeCommand_ReturnsNativeWithRemainingArgs()
    {
        var config = new Stub("config");
        var route = new Route([config]);

        var target = route.Resolve(["config", "get", "front.enabled"]);

        var native = Assert.IsType<Route.Native>(target);
        Assert.Same(config, native.Command);
        Assert.Equal(["get", "front.enabled"], native.Args.ToArray());
    }

    [Fact]
    public void Resolve_NoNativeForWord_ReturnsCoreWithArgvUnchanged()
    {
        var route = new Route([new Stub("config")]);

        var target = route.Resolve(["spec", "validate", "plan.md"]);

        Assert.Equal(["spec", "validate", "plan.md"], Assert.IsType<Route.Core>(target).Argv);
    }

    [Fact]
    public void Resolve_TwoWordNative_MatchesOnlyThatSubcommand()
    {
        var list = new Stub("plugin list");
        var route = new Route([list]);

        Assert.Same(list, Assert.IsType<Route.Native>(route.Resolve(["plugin", "list"])).Command);
        Assert.Equal(["plugin", "add", "x"], Assert.IsType<Route.Core>(route.Resolve(["plugin", "add", "x"])).Argv);
        Assert.IsType<Route.Core>(route.Resolve(["plugin"]));
    }

    [Fact]
    public void Resolve_WordAndPairBothNative_PrefersLongestMatch()
    {
        var all = new Stub("hooks");
        var run = new Stub("hooks run");
        var route = new Route([all, run]);

        Assert.Same(run, Assert.IsType<Route.Native>(route.Resolve(["hooks", "run", "pr-open"])).Command);
        Assert.Same(all, Assert.IsType<Route.Native>(route.Resolve(["hooks", "list"])).Command);
    }

    [Theory]
    [InlineData("nope")]
    [InlineData("toString")]
    [InlineData("--help")]
    public void Resolve_UnknownWord_ReturnsCoreSoBunPrintsItsOwnError(string word)
    {
        var route = new Route([]);

        Assert.Equal([word], Assert.IsType<Route.Core>(route.Resolve([word])).Argv);
    }

    [Fact]
    public void Resolve_EmptyArgv_ReturnsCoreWithEmptyArgv()
    {
        var route = new Route([new Stub("config")]);

        Assert.Empty(Assert.IsType<Route.Core>(route.Resolve([])).Argv);
    }
}

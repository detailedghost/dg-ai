using System.Text.Json;

namespace Dg.Routing.Tests;

public sealed class RouteParityTests
{
    private sealed record Record(string Word, string Program, string[] Command);

    private static Record[] BunRoutes()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Dg.slnx")))
        {
            dir = dir.Parent;
        }
        Assert.NotNull(dir);
        var path = Path.Combine(dir.FullName, "src", "Dg.Routing", "Generated", "obj", "routes.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return
        [
            .. doc.RootElement.EnumerateArray()
                .Select(static e => new Record(
                    e.GetProperty("word").GetString()!,
                    e.GetProperty("program").GetString()!,
                    [.. e.GetProperty("command").EnumerateArray().Select(static c => c.GetString()!)]
                )),
        ];
    }

    [Fact]
    public void Flat_EveryBunRoute_HasTheSameProgramAndCommand()
    {
        var bun = BunRoutes();

        Assert.NotEmpty(bun);
        Assert.Equal(bun.Length, RouteTable.Flat.Count);
        foreach (var expected in bun)
        {
            var actual = RouteTable.Flat[expected.Word];
            Assert.Equal(expected.Program, actual.Program);
            Assert.Equal(expected.Command, actual.Command);
        }
    }

    [Fact]
    public void Resolve_EveryBunRoute_TargetsDgCoreWithTheOriginalArgv()
    {
        var route = new Route([]);

        foreach (var expected in BunRoutes())
        {
            string[] argv = [expected.Word, "--flag", "value"];

            Assert.Equal(argv, Assert.IsType<Route.Core>(route.Resolve(argv)).Argv);
        }
    }

    [Theory]
    [InlineData("completion")]
    [InlineData("help")]
    [InlineData("start")]
    [InlineData("serve")]
    public void Flat_NamesBunDoesNotRouteFlat_AreAbsent(string word)
    {
        Assert.DoesNotContain(word, RouteTable.Flat.Keys);
    }
}

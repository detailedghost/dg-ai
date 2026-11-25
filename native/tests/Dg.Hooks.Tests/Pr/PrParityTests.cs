using Dg.Hooks.Defs.Pr;
using Dg.Hooks.Engine;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks.Tests.Pr;

public sealed class PrParityTests
{
    public static TheoryData<string> Names => PrFixtureCase.Names();

    [Theory]
    [MemberData(nameof(Names))]
    public async Task Run_Fixture_MatchesBunByteForByte(string name)
    {
        var fixture = PrFixtureCase.Load(name);
        Assert.SkipWhen(fixture.PosixOnly && OperatingSystem.IsWindows(), "needs a POSIX shell");
        var expected = PrFixtureCase.LoadExpected(name);

        var actual = await fixture.RunAsync();

        Assert.Equal(expected.Stdout, actual.Stdout);
        Assert.Equal(expected.Stderr, actual.Stderr);
        Assert.Equal(expected.Exit, actual.Exit);
        Assert.Equal(expected.After, actual.After);
    }

    [Fact]
    public void Fixtures_EveryCase_HasExpectedFile()
    {
        foreach (var file in Directory.GetFiles(PrFixtureCase.Directory, "*.case.json"))
            Assert.True(File.Exists(file.Replace(".case.json", ".expected.json", StringComparison.Ordinal)), file);
    }

    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;

    [Fact]
    public void AddPrHooks_Registers_ThreeHooksWithBunIds()
    {
        var services = new FakeServices();

        services.AddPrHooks();

        var ids = services
            .Where(descriptor => descriptor.ServiceType == typeof(IHook))
            .Select(descriptor => ((IHook)descriptor.ImplementationFactory!(null!)).Id)
            .Order()
            .ToArray();
        Assert.Equal(["pr-confirm", "pr-prose", "strip-ai-coauthors"], ids);
    }
}

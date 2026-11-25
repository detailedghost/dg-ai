using Dg.Parity.Tests.Harness;

namespace Dg.Parity.Tests;

public sealed class BunParityTests
{
    public static TheoryData<string> Version => Names(Cases.Version());

    public static TheoryData<string> Completion => Names(Cases.Completion());

    public static TheoryData<string> Config => Names(Cases.Config());

    public static TheoryData<string> Hooks => Names(Cases.Hooks());

    [Theory]
    [MemberData(nameof(Version))]
    public Task Version_Fixture_MatchesBunByteForByte(string name) => Check(Cases.Version(), name);

    [Theory]
    [MemberData(nameof(Completion))]
    public Task Completion_Fixture_MatchesBunByteForByte(string name) => Check(Cases.Completion(), name);

    [Theory]
    [MemberData(nameof(Config))]
    public Task Config_Fixture_MatchesBunByteForByte(string name) => Check(Cases.Config(), name);

    [Theory]
    [MemberData(nameof(Hooks))]
    public Task Hooks_Fixture_MatchesBunByteForByte(string name) => Check(Cases.Hooks(), name);

    private static Task Check(ParityCase[] all, string name)
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "the fake dg-core is a POSIX script");
        return Runners.AssertSameAsBunAsync(all.Single(c => c.Name == name));
    }

    private static TheoryData<string> Names(ParityCase[] all)
    {
        var data = new TheoryData<string>();
        foreach (var entry in all)
            data.Add(entry.Name);
        return data;
    }
}

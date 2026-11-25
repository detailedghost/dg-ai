using Dg.Parity.Tests.Harness;

namespace Dg.Parity.Tests;

public sealed class BunParityTests
{
    private static readonly Dictionary<string, ParityCase> VersionCases = ByName(Cases.Version());
    private static readonly Dictionary<string, ParityCase> CompletionCases = ByName(Cases.Completion());
    private static readonly Dictionary<string, ParityCase> ConfigCases = ByName(Cases.Config());
    private static readonly Dictionary<string, ParityCase> HookCases = ByName(Cases.Hooks());

    public static TheoryData<string> Version => Names(VersionCases);

    public static TheoryData<string> Completion => Names(CompletionCases);

    public static TheoryData<string> Config => Names(ConfigCases);

    public static TheoryData<string> Hooks => Names(HookCases);

    [Theory]
    [MemberData(nameof(Version))]
    public Task Version_Fixture_MatchesBunByteForByte(string name) => Check(VersionCases, name);

    [Theory]
    [MemberData(nameof(Completion))]
    public Task Completion_Fixture_MatchesBunByteForByte(string name) => Check(CompletionCases, name);

    [Theory]
    [MemberData(nameof(Config))]
    public Task Config_Fixture_MatchesBunByteForByte(string name) => Check(ConfigCases, name);

    [Theory]
    [MemberData(nameof(Hooks))]
    public Task Hooks_Fixture_MatchesBunByteForByte(string name) => Check(HookCases, name);

    private static Task Check(Dictionary<string, ParityCase> all, string name)
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "the fake dg-core is a POSIX script");
        return Runners.AssertSameAsBunAsync(all[name]);
    }

    private static Dictionary<string, ParityCase> ByName(ParityCase[] all)
    {
        var map = new Dictionary<string, ParityCase>(all.Length, StringComparer.Ordinal);
        foreach (var entry in all)
            map.Add(entry.Name, entry);
        return map;
    }

    private static TheoryData<string> Names(Dictionary<string, ParityCase> all)
    {
        var data = new TheoryData<string>();
        foreach (var name in all.Keys)
            data.Add(name);
        return data;
    }
}

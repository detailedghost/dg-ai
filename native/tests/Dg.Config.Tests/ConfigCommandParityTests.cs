using System.Runtime.CompilerServices;
using System.Text.Json;

namespace Dg.Config.Tests;

public sealed class ConfigCommandParityTests
{
    private sealed record Case(
        string Name,
        string[] Argv,
        string? Toml = null,
        Dictionary<string, string>? Files = null,
        bool Native = true,
        bool SyntaxOnly = false
    );

    private sealed record Expected(string Name, string Stdout, string Stderr, int Exit, string? File);

    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

    private static readonly Case[] Cases = Load<Case[]>("cases.json");

    private static readonly Dictionary<string, Expected> Bun = Load<Expected[]>("cases.expected.json")
        .ToDictionary(static e => e.Name);

    public static TheoryData<string> NativeNames => Names(native: true);

    public static TheoryData<string> HandoffNames => Names(native: false);

    [Theory]
    [MemberData(nameof(NativeNames))]
    public void Run_Fixture_MatchesBunStdoutStderrExitAndFile(string name)
    {
        var entry = Cases.Single(c => c.Name == name);
        var expected = Bun[name];
        using var home = Prepare(entry);

        var run = home.Run(entry.Argv);

        Assert.Equal(expected.Exit, run.Exit);
        Assert.Equal(expected.Stdout, run.Stdout);
        Assert.Equal(expected.File, run.File);
        if (entry.SyntaxOnly)
            AssertSyntaxError(expected.Stderr, run.Stderr);
        else
            Assert.Equal(expected.Stderr, run.Stderr);
    }

    [Theory]
    [MemberData(nameof(HandoffNames))]
    public void Run_UnsupportedCase_SignalsNotNativeAndChangesNothing(string name)
    {
        var entry = Cases.Single(c => c.Name == name);
        using var home = Prepare(entry);
        var before = entry.Toml;

        var run = home.Run(entry.Argv);

        Assert.Equal(ConfigExit.NotNative, run.Exit);
        Assert.Equal("", run.Stdout);
        Assert.Equal("", run.Stderr);
        Assert.Equal(before?.Replace(home.Path, "<home>", StringComparison.Ordinal), run.File);
    }

    [Fact]
    public void Fixtures_EveryCase_HasBunOutput()
    {
        Assert.Equal(Cases.Select(static c => c.Name).Order(), Bun.Keys.Order());
        Assert.All(Cases, c => Assert.Equal(c.Native, c.Native && Bun[c.Name].Exit is 0 or 1));
    }

    private static void AssertSyntaxError(string expected, string actual)
    {
        var prefix = expected[..(expected.IndexOf(": ", expected.IndexOf("config.toml:", StringComparison.Ordinal), StringComparison.Ordinal) + 2)];
        Assert.StartsWith(prefix, actual);
        Assert.EndsWith(". Next: run dg config edit, or dg config set <key> <value>.\n", actual);
    }

    private static TempHome Prepare(Case entry)
    {
        var home = new TempHome();
        if (entry.Toml is { } toml)
            home.Write(Path.Combine("config", "config.toml"), toml);
        foreach (var (relative, text) in entry.Files ?? [])
            home.Write(relative, text);
        return home;
    }

    private static TheoryData<string> Names(bool native)
    {
        var data = new TheoryData<string>();
        foreach (var entry in Cases.Where(c => c.Native == native))
            data.Add(entry.Name);
        return data;
    }

    private static T Load<T>(string name) =>
        JsonSerializer.Deserialize<T>(File.ReadAllText(Path.Combine(Folder(), "fixtures", name)), Options)!;

    private static string Folder([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}

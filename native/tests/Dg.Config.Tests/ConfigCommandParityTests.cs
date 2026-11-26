using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Dg.Core.Abstractions;

namespace Dg.Config.Tests;

public sealed class ConfigCommandParityTests
{
    private static readonly Case[] Cases = Deserialize(
        "cases.json",
        FixtureJson.Default.CaseArray
    );

    private static readonly Dictionary<string, Expected> Bun = Deserialize(
        "cases.expected.json",
        FixtureJson.Default.ExpectedArray
    ).ToDictionary(static e => e.Name);

    public static TheoryData<string> NativeNames => Names(native: true);

    public static TheoryData<string> HandoffNames => Names(native: false);

    public static TheoryData<string> FrontOnlyNames => FrontOnly();

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

        Assert.Equal(ExitCodes.NotNative, run.Exit);
        Assert.Equal("", run.Stdout);
        Assert.Equal("", run.Stderr);
        Assert.Equal(before?.Replace(home.Path, "<home>", StringComparison.Ordinal), run.File);
    }

    [Theory]
    [MemberData(nameof(FrontOnlyNames))]
    public void Run_FrontOnlyCase_BunRefusesAndFrontDoorKeepsItsOutput(string name)
    {
        var entry = Cases.Single(c => c.Name == name);
        var expected = Bun[name];
        using var home = Prepare(entry);

        var run = home.Run(entry.Argv);

        Assert.NotEqual(0, expected.Exit);
        Assert.Equal("", expected.Stdout);
        Assert.Contains($"dg {string.Join(' ', entry.Argv)} needs the C# front door", expected.Stderr);
        Assert.Equal(0, run.Exit);
        Assert.Equal("", run.Stderr);
        Assert.NotNull(entry.ExpectedLine);
        Assert.Contains(entry.ExpectedLine, run.Stdout);
    }

    [Fact]
    public void Fixtures_EveryCase_HasBunOutput()
    {
        Assert.Equal(Cases.Select(static c => c.Name).Order(), Bun.Keys.Order());
    }

    private static void AssertSyntaxError(string expected, string actual)
    {
        const string Location = "config.toml:";
        var location = expected.IndexOf(Location, StringComparison.Ordinal);
        Assert.True(location >= 0, $"fixture text has no {Location}: {expected}");
        var detail = expected.IndexOf(": ", location, StringComparison.Ordinal);
        Assert.True(detail >= 0, $"fixture text has no detail after {Location}: {expected}");
        Assert.StartsWith(expected[..(detail + 2)], actual);
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

    private static TheoryData<string> FrontOnly()
    {
        var data = new TheoryData<string>();
        foreach (var entry in Cases.Where(static c => c.FrontOnly))
            data.Add(entry.Name);
        return data;
    }

    private static TheoryData<string> Names(bool native)
    {
        var data = new TheoryData<string>();
        foreach (var entry in Cases.Where(c => c.Native == native && !c.FrontOnly))
            data.Add(entry.Name);
        return data;
    }

    private static T Deserialize<T>(string name, JsonTypeInfo<T> info) =>
        JsonSerializer.Deserialize(File.ReadAllText(Path.Combine(Folder(), "fixtures", name)), info)!;

    private static string Folder([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}

internal sealed record Case(
    string Name,
    string[] Argv,
    string? Toml = null,
    Dictionary<string, string>? Files = null,
    bool Native = true,
    bool SyntaxOnly = false,
    bool FrontOnly = false,
    string? ExpectedLine = null
);

internal sealed record Expected(string Name, string Stdout, string Stderr, int Exit, string? File);

[JsonSourceGenerationOptions(PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(Case[]))]
[JsonSerializable(typeof(Expected[]))]
internal sealed partial class FixtureJson : JsonSerializerContext;

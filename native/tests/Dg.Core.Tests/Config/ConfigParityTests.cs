using Dg.Core.Config;

namespace Dg.Core.Tests.Config;

public sealed class ConfigParityTests
{
    public static TheoryData<string> ValidNames => FixtureFiles.Names("ok-");

    public static TheoryData<string> InvalidNames => FixtureFiles.Names("err-");

    public static TheoryData<string> SyntaxNames => FixtureFiles.Names("syntax-");

    [Theory]
    [MemberData(nameof(ValidNames))]
    public void Parse_ValidFixture_MatchesBunValues(string name)
    {
        var result = DgConfig.Parse(FixtureFiles.Read($"{name}.toml"), "config.toml");

        Assert.True(result.IsOk, result.Error is { } error ? ConfigErrorText.Render(error) : "");
        Assert.Equal(FixtureFiles.Read($"{name}.ok.json").TrimEnd('\n'), DgTomlJson.Write(result.Value!));
    }

    [Theory]
    [MemberData(nameof(InvalidNames))]
    public void Parse_InvalidFixture_PrintsBunErrorText(string name)
    {
        var result = DgConfig.Parse(FixtureFiles.Read($"{name}.toml"), "config.toml");

        Assert.False(result.IsOk);
        Assert.Equal(FixtureFiles.Read($"{name}.error.txt").TrimEnd('\n'), ConfigErrorText.Render(result.Error!));
    }

    [Theory]
    [MemberData(nameof(SyntaxNames))]
    public void Parse_SyntaxFixture_MatchesBunFileLineAndNextStep(string name)
    {
        var expected = FixtureFiles.Read($"{name}.error.txt").TrimEnd('\n');
        var result = DgConfig.Parse(FixtureFiles.Read($"{name}.toml"), "config.toml");

        Assert.False(result.IsOk);
        var actual = ConfigErrorText.Render(result.Error!);
        var prefix = expected[..(expected.IndexOf(": ", "dg config: config.toml:".Length, StringComparison.Ordinal) + 2)];
        const string suffix = ". Next: run dg config edit, or dg config set <key> <value>.";
        Assert.StartsWith(prefix, actual);
        Assert.EndsWith(suffix, actual);
    }

    [Fact]
    public void Fixtures_EveryToml_HasExactlyOneExpectedFile()
    {
        foreach (var file in Directory.GetFiles(FixtureFiles.Directory, "*.toml"))
        {
            var stem = Path.Combine(
                Path.GetDirectoryName(file)!,
                Path.GetFileNameWithoutExtension(file)
            );
            var expected = new[] { File.Exists($"{stem}.ok.json"), File.Exists($"{stem}.error.txt") };
            Assert.Single(expected, found => found);
        }
    }
}

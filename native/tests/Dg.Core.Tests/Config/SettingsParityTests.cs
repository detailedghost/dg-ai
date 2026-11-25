using System.Text.Json;
using Dg.Core.Config;

namespace Dg.Core.Tests.Config;

public sealed class SettingsParityTests
{
    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        using var document = JsonDocument.Parse(FixtureFiles.Read("settings.cases.json"));
        foreach (var entry in document.RootElement.EnumerateArray())
            data.Add(entry.GetProperty("name").GetString()!);
        return data;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Setting_FixtureCase_MatchesBunPrecedenceAndError(string name)
    {
        using var cases = JsonDocument.Parse(FixtureFiles.Read("settings.cases.json"));
        using var expected = JsonDocument.Parse(FixtureFiles.Read("settings.expected.json"));
        var input = cases.RootElement.EnumerateArray().Single(e => e.GetProperty("name").GetString() == name);
        var output = expected.RootElement.EnumerateArray().Single(e => e.GetProperty("name").GetString() == name);
        Dictionary<string, string?> env = [];
        foreach (var variable in input.GetProperty("env").EnumerateObject())
            env[variable.Name] = variable.Value.GetString();
        var toml = DgConfig.Parse(input.GetProperty("toml").GetString()!, "config.toml").GetOrThrow();
        var settings = new DgSettings(toml, env);
        var key = input.GetProperty("key").GetString()!;
        var envVar = input.TryGetProperty("envVar", out var variableName) ? variableName.GetString() : null;
        var hasFlag = input.TryGetProperty("flag", out var flag);

        var (value, error) = input.GetProperty("type").GetString() switch
        {
            "bool" => Unwrap(settings.Bool(key, hasFlag ? flag.GetBoolean() : null, envVar)),
            _ => Unwrap(settings.String(key, hasFlag ? flag.GetString() : null, envVar)),
        };

        if (output.TryGetProperty("error", out var message))
        {
            Assert.NotNull(error);
            Assert.Equal(message.GetString(), ConfigErrorText.Render(error));
            return;
        }
        Assert.Null(error);
        var want = output.GetProperty("value");
        Assert.Equal(want.ValueKind == JsonValueKind.Null ? "null" : want.GetRawText(), TomlJson.Stringify(value));
    }

    private static (object? Value, Dg.Core.Errors.DgError? Error) Unwrap<T>(ConfigResult<T> result) =>
        (result.Value, result.Error);
}

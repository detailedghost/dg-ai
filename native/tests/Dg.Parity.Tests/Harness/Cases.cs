using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace Dg.Parity.Tests.Harness;

internal static class Cases
{
    private const int HookSampleStride = 4;

    private static readonly HashSet<string> ViaCoreByConfig =
    [
        "get-syntax-error",
        "get-bad-value",
        "get-unknown-section-in-file",
        "set-on-invalid-file",
        "set-on-syntax-error-file",
        "get-front-enabled-false",
    ];

    private static readonly string Tests = Path.GetDirectoryName(Path.GetDirectoryName(Folder()))!;

    public static ParityCase[] Config() =>
        Read(Path.Combine(Tests, "Dg.Config.Tests", "fixtures", "cases.json"))
            .EnumerateArray()
            .Where(static e => !e.TryGetProperty("frontOnly", out var only) || !only.GetBoolean())
            .Select(static e => new ParityCase(
                e.GetProperty("name").GetString()!,
                Strings(e.GetProperty("argv")),
                Config: e.TryGetProperty("toml", out var toml) ? toml.GetString() : null,
                Files: e.TryGetProperty("files", out var files)
                    ? files.EnumerateObject().ToDictionary(
                        static f => $"home/{f.Name}",
                        static f => Encoding.UTF8.GetBytes(f.Value.GetString()!)
                    )
                    : null,
                ViaCore: (e.TryGetProperty("native", out var native) && !native.GetBoolean()) || ViaCoreByConfig.Contains(e.GetProperty("name").GetString()!)
            ))
            .ToArray();

    public static ParityCase[] Completion()
    {
        var parity = Path.Combine(Tests, "..", "src", "Dg.Completion", "bin", "completion", "parity.json");
        return Read(parity)
            .EnumerateArray()
            .Select(static (e, i) => new ParityCase(
                $"complete-{i:00}",
                ["__complete", .. Strings(e.GetProperty("words"))],
                ViaCore: e.GetProperty("words").GetArrayLength() < 2
            ))
            .ToArray();
    }

    public static ParityCase[] Version() =>
        [
            new("version", ["--version"]),
            new("version-built", ["--version"], Env: new Dictionary<string, string> { ["DG_BUILD_VERSION"] = "9.8.7-parity" }),
            new("version-extra-args", ["--version", "extra"]),
        ];

    public static ParityCase[] Hooks() => [.. Fixed(), .. PrSample()];

    private static ParityCase[] Fixed() =>
        Read(Path.Combine(Folder(), "..", "fixtures", "hooks.json"))
            .EnumerateArray()
            .Select(ToCase)
            .ToArray();

    private static IEnumerable<ParityCase> PrSample()
    {
        var folder = Path.Combine(Tests, "Dg.Hooks.Tests", "Pr", "fixtures");
        return Directory
            .GetFiles(folder, "*.case.json")
            .Order(StringComparer.Ordinal)
            .Where(static (_, i) => i % HookSampleStride == 0)
            .Select(file => ToCase(Read(file), Path.GetFileName(file)[..^".case.json".Length]));
    }

    private static ParityCase ToCase(JsonElement e) => ToCase(e, e.GetProperty("name").GetString()!);

    private static ParityCase ToCase(JsonElement e, string name)
    {
        string[] argv = e.TryGetProperty("argv", out var explicitArgv)
            ? Strings(explicitArgv)
            : ["hooks", "run", e.GetProperty("hook").GetString()!, .. e.TryGetProperty("args", out var args) ? Strings(args) : []];
        var stdin = e.TryGetProperty("stdin", out var raw) ? raw.GetString()
            : e.TryGetProperty("event", out var ev) ? ev.GetRawText()
            : null;
        return new ParityCase(
            name,
            argv,
            stdin,
            e.TryGetProperty("config", out var config) ? config.GetString() : null,
            e.TryGetProperty("env", out var env) ? Map(env) : null,
            e.TryGetProperty("files", out var files) ? Files(files) : null,
            e.TryGetProperty("bin", out var bin) ? Map(bin) : null,
            e.TryGetProperty("cwd", out var cwd) ? cwd.GetString() : null,
            e.TryGetProperty("viaCore", out var viaCore) && viaCore.GetBoolean()
        );
    }

    private static Dictionary<string, string> Map(JsonElement element) =>
        element.EnumerateObject().ToDictionary(static p => p.Name, static p => p.Value.GetString()!);

    private static Dictionary<string, byte[]> Files(JsonElement element) =>
        element
            .EnumerateObject()
            .ToDictionary(
                static p => p.Name,
                static p =>
                    p.Value.ValueKind == JsonValueKind.String
                        ? Encoding.UTF8.GetBytes(p.Value.GetString()!)
                        : Convert.FromBase64String(p.Value.GetProperty("base64").GetString()!)
            );

    private static string[] Strings(JsonElement element) =>
        element.EnumerateArray().Select(static x => x.GetString()!).ToArray();

    private static JsonElement Read(string path) => JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone();

    private static string Folder([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}

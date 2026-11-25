using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Dg.Core.Abstractions;
using Dg.Core.Output;

namespace Dg.Plugins.Tests;

public sealed class PluginCommandParityTests
{
    private static readonly Dictionary<string, Case> Cases = Deserialize("cases.json", FixtureJson.Default.Spec)
        .Cases.ToDictionary(static c => c.Name);

    private static readonly Dictionary<string, Expected> Bun = Deserialize(
        "cases.expected.json",
        FixtureJson.Default.ExpectedArray
    ).ToDictionary(static e => e.Name);

    public static TheoryData<string> NativeNames => Names(native: true);

    public static TheoryData<string> HandoffNames => Names(native: false);

    [Theory]
    [MemberData(nameof(NativeNames))]
    public void Run_Fixture_MatchesBunStdoutStderrExitAndFiles(string name)
    {
        var expected = Bun[name];
        using var home = Materialize(expected, Cases[name]);

        var run = home.Run(Cases[name].Argv);

        Assert.Equal(expected.Exit, run.Exit);
        Assert.Equal(expected.Stdout, run.Stdout);
        Assert.Equal(expected.Stderr, run.Stderr);
        Assert.Equal(expected.After, run.Files);
    }

    [Theory]
    [MemberData(nameof(HandoffNames))]
    public void Run_UnsupportedCase_SignalsNotNativeAndChangesNothing(string name)
    {
        var expected = Bun[name];
        using var home = Materialize(expected, Cases[name]);

        var run = home.Run(Cases[name].Argv);

        Assert.Equal(ExitCodes.NotNative, run.Exit);
        Assert.Equal("", run.Stdout);
        Assert.Equal("", run.Stderr);
        Assert.Equal(expected.Setup, run.Files);
    }

    [Fact]
    public void Fixtures_EveryCase_HasBunOutput()
    {
        Assert.Equal(Cases.Keys.Order(), Bun.Keys.Order());
    }

    private static TempHome Materialize(Expected expected, Case entry)
    {
        var home = new TempHome(entry.Env);
        foreach (var (relative, text) in expected.Setup)
        {
            if (text == "<symlink>")
                home.Symlink(relative, "SKILL.md");
            else
                home.Write(relative, text);
        }
        return home;
    }

    private static TheoryData<string> Names(bool native)
    {
        var data = new TheoryData<string>();
        foreach (var entry in Cases.Values.Where(c => c.Native == native))
            data.Add(entry.Name);
        return data;
    }

    private static T Deserialize<T>(string name, JsonTypeInfo<T> info) =>
        JsonSerializer.Deserialize(File.ReadAllText(Path.Combine(Folder(), "fixtures", name)), info)!;

    private static string Folder([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}

internal sealed record Case(string Name, string[] Argv, bool Native = true, Dictionary<string, string>? Env = null);

internal sealed record Spec(Case[] Cases);

internal sealed record Expected(
    string Name,
    Dictionary<string, string> Setup,
    string Stdout,
    string Stderr,
    int Exit,
    Dictionary<string, string> After
);

[JsonSourceGenerationOptions(PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(Spec))]
[JsonSerializable(typeof(Expected[]))]
internal sealed partial class FixtureJson : JsonSerializerContext;

internal sealed record CommandRun(string Stdout, string Stderr, int Exit, Dictionary<string, string> Files);

internal sealed class TempHome : IDisposable
{
    private static readonly string[] Skipped = ["sources", ".bun", ".cache"];

    private readonly Dictionary<string, string?> _env;

    public TempHome(Dictionary<string, string>? extra = null)
    {
        Path = Directory.CreateTempSubdirectory("dg-plugin-test-").FullName;
        _env = new Dictionary<string, string?>
        {
            ["DG_HOME"] = Path,
            ["DG_PATH_FENCE"] = Path,
            ["HOME"] = Path,
        };
        foreach (var (key, value) in extra ?? [])
            _env[key] = value.Replace("<home>", Path, StringComparison.Ordinal);
    }

    public string Path { get; }

    public void Write(string relative, string text)
    {
        var file = System.IO.Path.Combine(Path, relative);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text.Replace("<home>", Path, StringComparison.Ordinal));
    }

    public void Symlink(string relative, string target)
    {
        var file = System.IO.Path.Combine(Path, relative);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
        File.CreateSymbolicLink(file, target);
    }

    public CommandRun Run(params string[] argv)
    {
        using var output = new MemoryStream();
        using var error = new MemoryStream();
        var exit = Dispatch(Commands(new OutputWriter(output), new OutputWriter(error)), argv);
        return new CommandRun(Strip(output), Strip(error), exit, Snapshot());
    }

    private ICommand[] Commands(OutputWriter output, OutputWriter error) =>
        [new PluginListCommand(_env, output, error), new PluginVerifyCommand(_env, output, error)];

    public void Dispose() => Directory.Delete(Path, recursive: true);

    private Dictionary<string, string> Snapshot()
    {
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var file in Directory.EnumerateFiles(Path, "*", SearchOption.AllDirectories))
        {
            var relative = System.IO.Path.GetRelativePath(Path, file).Replace('\\', '/');
            if (Skipped.Contains(relative.Split('/')[0]))
                continue;
            files[relative] =
                new FileInfo(file).LinkTarget is not null
                    ? "<symlink>"
                    : File.ReadAllText(file).Replace(Path, "<home>", StringComparison.Ordinal);
        }
        return new Dictionary<string, string>(files);
    }

    private static int Dispatch(ICommand[] commands, string[] argv)
    {
        foreach (var command in commands)
        {
            var words = command.Name.Split(' ');
            if (argv.Length >= words.Length && argv.AsSpan(0, words.Length).SequenceEqual(words))
                return command.RunAsync(argv[words.Length..], CancellationToken.None).AsTask().GetAwaiter().GetResult();
        }
        return ExitCodes.NotNative;
    }

    private string Strip(MemoryStream stream) =>
        Encoding.UTF8.GetString(stream.ToArray()).Replace(Path, "<home>", StringComparison.Ordinal);
}

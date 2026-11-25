using System.Text;
using Dg.Core.Abstractions;
using Dg.Core.Output;

namespace Dg.Config.Tests;

internal sealed record CommandRun(string Stdout, string Stderr, int Exit, string? File);

internal sealed class TempHome : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory("dg-config-test-").FullName;

    public string ConfigFile => System.IO.Path.Combine(Path, "config", "config.toml");

    public IReadOnlyDictionary<string, string?> Env =>
        new Dictionary<string, string?>
        {
            ["DG_HOME"] = Path,
            ["DG_PATH_FENCE"] = Path,
            ["HOME"] = Path,
        };

    public void Write(string relative, string text)
    {
        var file = System.IO.Path.Combine(Path, relative);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
        File.WriteAllText(file, text);
    }

    public CommandRun Run(params string[] argv)
    {
        using var output = new MemoryStream();
        using var error = new MemoryStream();
        var commands = ConfigCommands.Create(Env, new OutputWriter(output), new OutputWriter(error));
        var exit = Dispatch(commands, argv);
        var file = File.Exists(ConfigFile) ? File.ReadAllText(ConfigFile) : null;
        return new CommandRun(
            Strip(output),
            Strip(error),
            exit,
            file?.Replace(Path, "<home>", StringComparison.Ordinal)
        );
    }

    public void Dispose() => Directory.Delete(Path, recursive: true);

    private static int Dispatch(ICommand[] commands, string[] argv)
    {
        foreach (var command in commands)
        {
            var words = command.Name.Split(' ');
            if (argv.Length >= words.Length && argv.AsSpan(0, words.Length).SequenceEqual(words))
                return command.RunAsync(argv[words.Length..], CancellationToken.None).AsTask().GetAwaiter().GetResult();
        }
        throw new InvalidOperationException($"no command for {string.Join(' ', argv)}");
    }

    private string Strip(MemoryStream stream) =>
        Encoding.UTF8.GetString(stream.ToArray()).Replace(Path, "<home>", StringComparison.Ordinal);
}

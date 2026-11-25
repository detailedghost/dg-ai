using System.Text;

namespace Dg.Parity.Tests.Harness;

internal sealed record ParityCase(
    string Name,
    string[] Argv,
    string? Stdin = null,
    string? Config = null,
    IReadOnlyDictionary<string, string>? Env = null,
    IReadOnlyDictionary<string, byte[]>? Files = null,
    IReadOnlyDictionary<string, string>? Bin = null,
    string? Cwd = null
);

internal sealed record Observed(
    int Exit,
    string Stdout,
    string Stderr,
    string? Config,
    SortedDictionary<string, string> After
);

internal sealed class Sandbox : IDisposable
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly string[] Unwatched = ["home", "bin", ".git"];

    public string Root { get; } = Directory.CreateTempSubdirectory("dg-parity-").FullName;

    public string Home => Path.Combine(Root, "home");

    public string ConfigFile => Path.Combine(Home, "config", "config.toml");

    public Sandbox()
    {
        foreach (var sub in new[] { "home", "work", "bin", "repo" })
            Directory.CreateDirectory(Path.Combine(Root, sub));
    }

    public string Substitute(string text) => text.Replace("$CWD", Root, StringComparison.Ordinal);

    public void Materialize(ParityCase entry)
    {
        if (entry.Files is { } files)
            foreach (var (relative, bytes) in files)
            {
                var target = Path.Combine(Root, Substitute(relative));
                if (relative.EndsWith('/'))
                {
                    Directory.CreateDirectory(target);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.WriteAllBytes(target, bytes);
            }
        if (entry.Bin is { } bin)
            foreach (var (name, script) in bin)
            {
                var target = Path.Combine(Root, "bin", name);
                File.WriteAllText(target, script);
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        if (entry.Config is { } config)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigFile)!);
            File.WriteAllText(ConfigFile, config);
        }
    }

    public Dictionary<string, string> Env(ParityCase entry, FrontDoorHost host, string core)
    {
        var realPath = Environment.GetEnvironmentVariable("PATH") ?? "";
        Dictionary<string, string> env = new(StringComparer.Ordinal)
        {
            ["HOME"] = Home,
            ["TMPDIR"] = Path.Combine(Root, "work"),
            ["DG_HOME"] = Home,
            ["DG_PATH_FENCE"] = Root,
            ["AI_SCRATCH_DIR"] = Path.Combine(Root, "scratch"),
            ["PATH"] = $"{Path.Combine(Root, "bin")}{Path.PathSeparator}{realPath}",
            ["DOTNET_ROOT"] = host.DotnetRoot,
            ["DOTNET_EnableDiagnostics"] = "0",
            ["DG_PARITY_CORE"] = core,
            ["DG_PARITY_BUN"] = host.Bun,
            ["DG_PARITY_INDEX"] = host.BunIndex,
        };
        if (entry.Env is { } extra)
            foreach (var (key, value) in extra)
                env[key] = Substitute(value);
        return env;
    }

    public string Normalize(string text) => text.Replace(Root, "<root>", StringComparison.Ordinal);

    public string WorkingDirectory(ParityCase entry) =>
        entry.Cwd is { } cwd ? Path.Combine(Root, Substitute(cwd)) : Path.Combine(Root, "work");

    public Observed Observe(RunResult run)
    {
        var config = File.Exists(ConfigFile) ? Normalize(File.ReadAllText(ConfigFile)) : null;
        return new Observed(run.Exit, Normalize(run.Stdout), Normalize(run.Stderr), config, Snapshot());
    }

    public void Dispose() => Directory.Delete(Root, recursive: true);

    private SortedDictionary<string, string> Snapshot()
    {
        SortedDictionary<string, string> files = new(StringComparer.Ordinal);
        Walk(Root);
        return files;

        void Walk(string directory)
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                var relative = Path.GetRelativePath(Root, path).Replace('\\', '/');
                if (directory == Root && Unwatched.Contains(relative))
                    continue;
                if (Directory.Exists(path))
                {
                    Walk(path);
                    continue;
                }
                var bytes = File.ReadAllBytes(path);
                try
                {
                    files[relative] = Normalize(StrictUtf8.GetString(bytes));
                }
                catch (DecoderFallbackException)
                {
                    files[relative] = $"base64:{Convert.ToBase64String(bytes)}";
                }
            }
        }
    }
}

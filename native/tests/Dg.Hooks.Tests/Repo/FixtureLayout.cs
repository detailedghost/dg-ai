using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Dg.Hooks.Defs.Repo;
using Dg.Hooks.Shared;

namespace Dg.Hooks.Tests.Repo;

internal sealed record LayoutEntry(
    string Path,
    string? Kind = null,
    double? AgeDays = null,
    string? Target = null,
    string? Mode = null
);

internal sealed record LayoutWorktree(string Path, string Branch);

internal sealed record LayoutRepo(
    string Path,
    Dictionary<string, string> Files,
    List<LayoutWorktree>? Worktrees = null
);

internal sealed record RunnerRule(
    string[] Match,
    int Status = 0,
    string Stdout = "",
    string Stderr = ""
);

internal sealed record FixtureCase
{
    public required string Hook { get; init; }
    public string[]? Args { get; init; }
    public JsonElement? Stdin { get; init; }
    public List<LayoutEntry>? Entries { get; init; }
    public List<LayoutRepo>? Repos { get; init; }
    public List<RunnerRule>? Runner { get; init; }
    public Dictionary<string, string?>? Env { get; init; }
    public bool SpawnThrows { get; init; }
}

[JsonSourceGenerationOptions(PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(FixtureCase))]
internal sealed partial class FixtureJson : JsonSerializerContext;

internal static class FixtureCases
{
    public static string FixturesPath { get; } =
        Path.Combine(Path.GetDirectoryName(ThisFile())!, "fixtures");

    public static TheoryData<string> Names(string prefix)
    {
        var data = new TheoryData<string>();
        foreach (var file in Directory.GetFiles(FixturesPath, $"{prefix}*.case.json").Order())
            data.Add(Path.GetFileName(file)[..^".case.json".Length]);
        return data;
    }

    public static FixtureCase Load(string name) =>
        JsonSerializer.Deserialize<FixtureCase>(
            File.ReadAllText(Path.Combine(FixturesPath, $"{name}.case.json")),
            FixtureJson.Default.FixtureCase
        )!;

    public static string Expected(string name) =>
        File.ReadAllText(Path.Combine(FixturesPath, $"{name}.expected.txt"));

    private static string ThisFile([CallerFilePath] string path = "") => path;
}

internal sealed class FixtureLayout : IDisposable
{
    private static readonly Dictionary<string, string> GitEnv = new()
    {
        ["GIT_CONFIG_NOSYSTEM"] = "1",
        ["GIT_CONFIG_GLOBAL"] = "/dev/null",
        ["GIT_AUTHOR_NAME"] = "fixture",
        ["GIT_AUTHOR_EMAIL"] = "fixture@example.invalid",
        ["GIT_COMMITTER_NAME"] = "fixture",
        ["GIT_COMMITTER_EMAIL"] = "fixture@example.invalid",
    };

    private FixtureLayout(string root) => Root = root;

    public string Root { get; }

    public bool HasAgedSymlink { get; private set; }

    public static FixtureLayout Build(FixtureCase c)
    {
        var temp = FsPaths.RealPath(Path.GetTempPath());
        var root = FsPaths.RealPath(Directory.CreateTempSubdirectory("dg-hooks-repo-").FullName);
        if (!root.StartsWith(temp, StringComparison.Ordinal))
            throw new InvalidOperationException($"refusing fixture root outside {temp}: {root}");
        var layout = new FixtureLayout(root);
        layout.Populate(c);
        return layout;
    }

    public string Join(params string[] parts) => Path.Combine([Root, .. parts]);

    public List<string> Tree()
    {
        List<string> lines = [];
        Walk(Root, lines);
        lines.Sort(StringComparer.Ordinal);
        return lines;
    }

    public void Dispose()
    {
        try
        {
            if (OperatingSystem.IsWindows())
                foreach (var file in Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories))
                    File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(Root, recursive: true);
        }
        catch (IOException) { }
    }

    private void Walk(string dir, List<string> lines)
    {
        foreach (var path in Directory.GetFileSystemEntries(dir))
        {
            var name = Path.GetFileName(path);
            if (name == ".git")
                continue;
            var rel = Path.GetRelativePath(Root, path).Replace('\\', '/');
            var info = new FileInfo(path);
            if (info.LinkTarget is { } target)
                lines.Add($"{rel} -> {target.Replace(Root, "<ROOT>", StringComparison.Ordinal)}");
            else if (info.Attributes.HasFlag(FileAttributes.Directory))
            {
                lines.Add($"{rel}/");
                Walk(path, lines);
            }
            else
                lines.Add(rel);
        }
    }

    private void Populate(FixtureCase c)
    {
        foreach (var sub in new[] { "scratch", "state", "code", "home", "outside", "xdg" })
            Directory.CreateDirectory(Join(sub));
        foreach (var repo in c.Repos ?? [])
            BuildRepo(repo);

        var nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        Dictionary<string, double> ages = [];
        Dictionary<string, string> kinds = [];
        HashSet<string> links = [];
        foreach (var e in c.Entries ?? [])
        {
            var path = Join(e.Path);
            var kind = e.Kind ?? "file";
            kinds[path] = kind;
            ages[path] = e.AgeDays ?? 0;
            Directory.CreateDirectory(kind == "dir" ? path : Path.GetDirectoryName(path)!);
            if (kind == "symlink")
            {
                File.CreateSymbolicLink(path, e.Target!.Replace("<ROOT>", Root, StringComparison.Ordinal));
                links.Add(path);
                HasAgedSymlink |= (e.AgeDays ?? 0) > 0;
            }
            else if (kind != "dir")
                File.WriteAllText(path, "x");
        }

        Dictionary<string, double> implicitAges = [];
        foreach (var (path, age) in ages)
        {
            for (var d = Path.GetDirectoryName(path); IsUnderRoot(d); d = Path.GetDirectoryName(d))
            {
                if (kinds.ContainsKey(d))
                    continue;
                if (!implicitAges.TryGetValue(d, out var known) || age < known)
                    implicitAges[d] = age;
            }
        }

        void Stamp(string path, double age)
        {
            var when = DateTimeOffset.FromUnixTimeSeconds((long)(nowSec - age * 86_400)).UtcDateTime;
            if (links.Contains(path))
                TouchLink(path, when);
            else if (Directory.Exists(path))
                Directory.SetLastWriteTimeUtc(path, when);
            else
                File.SetLastWriteTimeUtc(path, when);
        }

        foreach (var (path, age) in ages)
            Stamp(path, age);
        foreach (var (path, age) in implicitAges)
            Stamp(path, age);
        foreach (var e in c.Entries ?? [])
            if (e.Mode is { } mode && !OperatingSystem.IsWindows())
                File.SetUnixFileMode(Join(e.Path), (UnixFileMode)Convert.ToInt32(mode, 8));
    }

    private void BuildRepo(LayoutRepo repo)
    {
        var path = Join(repo.Path);
        Directory.CreateDirectory(path);
        Git(path, "init", "-q", "-b", "main");
        foreach (var (rel, text) in repo.Files)
        {
            var file = Path.Combine(path, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, text);
        }
        Git(path, "add", "-A");
        Git(path, "commit", "-q", "-m", "init");
        foreach (var wt in repo.Worktrees ?? [])
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Join(wt.Path))!);
            Git(path, "worktree", "add", "-q", "-b", wt.Branch, Join(wt.Path));
        }
    }

    private static void Git(string cwd, params string[] args) =>
        Run("git", cwd, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", .. args]);

    private static void TouchLink(string path, DateTime when)
    {
        var seconds = new DateTimeOffset(when).ToUnixTimeSeconds();
        Run("touch", Path.GetDirectoryName(path)!, ["-h", "-d", $"@{seconds}", path]);
    }

    private bool IsUnderRoot([NotNullWhen(true)] string? directory) =>
        directory is not null && directory.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    private static void Run(string file, string cwd, string[] args)
    {
        var info = new ProcessStartInfo(file)
        {
            WorkingDirectory = cwd,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args)
            info.ArgumentList.Add(arg);
        foreach (var (key, value) in GitEnv)
            info.Environment[key] = value;
        info.Environment["XDG_CONFIG_HOME"] = Path.Combine(cwd, ".no-xdg");
        using var process = Process.Start(info)!;
        var error = process.StandardError.ReadToEndAsync();
        process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"{file} {string.Join(' ', args)}: {error.Result}");
    }
}

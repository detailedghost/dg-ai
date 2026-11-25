using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace Dg.Hooks.Tests.Text;

internal sealed class TextFixtureCase
{
    private const string Placeholder = "<ROOT>";

    public required string Name { get; init; }
    public required string Hook { get; init; }
    public required string Event { get; init; }
    public required IReadOnlyDictionary<string, string?> Env { get; init; }
    public required IReadOnlyList<(string Rel, JsonElement Spec)> Files { get; init; }
    public required IReadOnlyList<(string Name, string Text)> Bin { get; init; }
    public required IReadOnlyList<(string Rel, string Mode)> Chmod { get; init; }
    public required IReadOnlyList<string> Requires { get; init; }
    public string? KnownGap { get; init; }

    public static string Directory { get; } = Path.Combine(Folder(), "fixtures");

    private const string LogHead =
        "#!/bin/sh\n"
        + "case \"$PWD\" in \"$FIXTURE_ROOT\"*) c=${PWD#\"$FIXTURE_ROOT\"};; *) c=-;; esac\n"
        + "printf '%s %s | cwd=%s\\n' \"${0##*/}\" \"$*\" \"$c\" >> \"$FIXTURE_ROOT/log\"\n";

    public static IReadOnlyList<TextFixtureCase> All { get; } = Load();

    public static TheoryData<string> Names(string hook)
    {
        var data = new TheoryData<string>();
        foreach (var entry in All.Where(c => c.Hook == hook))
            data.Add(entry.Name);
        return data;
    }

    public static TextFixtureCase Get(string name) => All.Single(c => c.Name == name);

    public string Expected(string extension) => File.ReadAllText(Path.Combine(Directory, $"{Name}.{extension}"));

    public bool Available()
    {
        var path = Env.TryGetValue("PATH", out var value) && value is not null ? value : $"{Placeholder}/bin";
        var dirs = path.Split(':').Where(d => !d.Contains(Placeholder, StringComparison.Ordinal));
        return Requires.All(bin => dirs.Any(d => File.Exists(Path.Combine(d, bin))));
    }

    public Materialized Materialize()
    {
        var root = Path.GetFullPath(Directory_Create());
        string Sub(string text) => text.Replace(Placeholder, root, StringComparison.Ordinal);
        MakeDirs(Path.Combine(root, "bin"));
        MakeDirs(Path.Combine(root, "home"));
        Put(Path.Combine(root, "log"), "", null, null);
        Put(Path.Combine(root, "work", ".git", "HEAD"), "", null, null);
        foreach (var (name, text) in Bin)
            Put(Path.Combine(root, "bin", name), text, "755", null);
        foreach (var (rel, spec) in Files)
        {
            if (spec.ValueKind == JsonValueKind.String)
                Put(Path.Combine(root, rel), spec.GetString()!, null, null);
            else
            {
                var content = spec.TryGetProperty("content", out var c) ? c.GetString() : "";
                var mode = spec.TryGetProperty("mode", out var m) ? m.GetString() : null;
                var link = spec.TryGetProperty("symlink", out var l) ? l.GetString() : null;
                Put(Path.Combine(root, rel), content ?? "", mode, link);
            }
        }
        foreach (var (rel, mode) in Chmod)
            File.SetUnixFileMode(Path.Combine(root, rel), (UnixFileMode)Convert.ToInt32(mode, 8));

        Dictionary<string, string?> env = new()
        {
            ["HOME"] = Path.Combine(root, "home"),
            ["DG_HOME"] = Path.Combine(root, "dg"),
            ["DG_PATH_FENCE"] = root,
            ["AI_SCRATCH_DIR"] = Path.Combine(root, "scratch"),
            ["CLAUDE_CODE_SESSION_ID"] = "fixsess",
            ["FIXTURE_ROOT"] = root,
            ["PATH"] = Path.Combine(root, "bin"),
        };
        foreach (var (key, value) in Env)
        {
            if (value is null)
                env.Remove(key);
            else
                env[key] = Sub(value);
        }
        return new Materialized(root, env, Encoding.UTF8.GetBytes(Sub(Event)));
    }

    public static string Snapshot(string root)
    {
        StringBuilder text = new();
        Walk(root);
        return text.ToString();

        void Walk(string path)
        {
            var entries = new DirectoryInfo(path)
                .GetFileSystemInfos()
                .OrderBy(e => e.Name, StringComparer.Ordinal);
            foreach (var entry in entries)
            {
                var rel = Path.GetRelativePath(root, entry.FullName).Replace('\\', '/');
                if (rel is "bin" or "scratch" or "home" or "dg")
                    continue;
                if (entry.LinkTarget is { } target)
                    text.Append($"== {rel} -> {target}\n");
                else if (entry is DirectoryInfo)
                    Walk(entry.FullName);
                else
                {
                    var mode = Convert.ToString((int)File.GetUnixFileMode(entry.FullName) & 0x1FF, 8);
                    text.Append($"== {rel} {mode}\n{File.ReadAllText(entry.FullName)}\n");
                }
            }
        }
    }

    private static string Directory_Create()
    {
        var path = System.IO.Directory.CreateTempSubdirectory("dg-hooks-text-");
        return path.ResolveLinkTarget(true)?.FullName ?? path.FullName;
    }

    private static void MakeDirs(string path)
    {
        if (System.IO.Directory.Exists(path))
            return;
        MakeDirs(Path.GetDirectoryName(path)!);
        System.IO.Directory.CreateDirectory(path);
        File.SetUnixFileMode(path, (UnixFileMode)Convert.ToInt32("755", 8));
    }

    private static void Put(string path, string text, string? mode, string? symlink)
    {
        MakeDirs(Path.GetDirectoryName(path)!);
        if (symlink is not null)
        {
            File.CreateSymbolicLink(path, symlink);
            return;
        }
        File.WriteAllText(path, ScriptText(text));
        File.SetUnixFileMode(path, (UnixFileMode)Convert.ToInt32(mode ?? "644", 8));
    }

    private static string ScriptText(string text) =>
        text.StartsWith("@log", StringComparison.Ordinal)
            ? LogHead + text[4..].TrimStart('\n') + (text.Length > 4 ? "\n" : "")
            : text;

    private static List<TextFixtureCase> Load()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Directory, "cases.json")));
        List<TextFixtureCase> cases = [];
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            var evt = item.GetProperty("event");
            cases.Add(
                new TextFixtureCase
                {
                    Name = item.GetProperty("name").GetString()!,
                    Hook = item.GetProperty("hook").GetString()!,
                    Event = evt.ValueKind == JsonValueKind.String ? evt.GetString()! : evt.GetRawText(),
                    Env = Object(item, "env", e => e.ValueKind == JsonValueKind.Null ? null : e.GetString()),
                    Files = [.. Object(item, "files", e => e.Clone()).Select(p => (p.Key, p.Value))],
                    Bin = [.. Object(item, "bin", e => e.GetString()!).Select(p => (p.Key, p.Value))],
                    Chmod = [.. Object(item, "chmod", e => e.GetString()!).Select(p => (p.Key, p.Value))],
                    Requires = item.TryGetProperty("requires", out var req)
                        ? [.. req.EnumerateArray().Select(e => e.GetString()!)]
                        : [],
                    KnownGap = item.TryGetProperty("knownGap", out var gap) ? gap.GetString() : null,
                }
            );
        }
        return cases;
    }

    private static Dictionary<string, T> Object<T>(JsonElement item, string name, Func<JsonElement, T> read)
    {
        Dictionary<string, T> map = [];
        if (item.TryGetProperty(name, out var obj))
            foreach (var property in obj.EnumerateObject())
                map[property.Name] = read(property.Value);
        return map;
    }

    private static string Folder([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}

internal sealed record Materialized(string Root, IReadOnlyDictionary<string, string?> Env, byte[] Stdin);

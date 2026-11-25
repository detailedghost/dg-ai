using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Dg.Core.Paths;
using Dg.Hooks.Defs.Pr;
using Dg.Hooks.Engine;

namespace Dg.Hooks.Tests.Pr;

internal sealed record PrRun(int Exit, string Stdout, string Stderr, SortedDictionary<string, string> After);

internal sealed class PrFixtureCase
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public static string Directory { get; } = Path.Combine(Folder(), "fixtures");

    private readonly JsonElement _case;

    private PrFixtureCase(JsonElement element) => _case = element;

    public bool PosixOnly => _case.TryGetProperty("posixOnly", out var flag) && flag.GetBoolean();

    public static TheoryData<string> Names()
    {
        var data = new TheoryData<string>();
        foreach (var file in System.IO.Directory.GetFiles(Directory, "*.case.json").Order())
            data.Add(Path.GetFileName(file)[..^".case.json".Length]);
        return data;
    }

    public static PrFixtureCase Load(string name) =>
        new(JsonDocument.Parse(File.ReadAllText(Path.Combine(Directory, $"{name}.case.json"))).RootElement.Clone());

    public static PrRun LoadExpected(string name)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(Directory, $"{name}.expected.json")));
        var root = document.RootElement;
        SortedDictionary<string, string> after = new(StringComparer.Ordinal);
        foreach (var file in root.GetProperty("after").EnumerateObject())
            after[file.Name] = file.Value.GetString()!;
        return new PrRun(
            root.GetProperty("exit").GetInt32(),
            root.GetProperty("stdout").GetString()!,
            root.GetProperty("stderr").GetString()!,
            after
        );
    }

    public async Task<PrRun> RunAsync()
    {
        var root = System.IO.Directory.CreateTempSubdirectory("dg-hooks-pr-").FullName;
        try
        {
            foreach (var sub in new[] { "work", "bin", "home", "repo" })
                System.IO.Directory.CreateDirectory(Path.Combine(root, sub));
            var env = BuildEnv(root);
            Plant(root);
            WriteConfig(root, env);

            var output = new StringWriter();
            var error = new StringWriter();
            var host = new PrHookHost(env, output, error);
            var engine = new HookEngine(
                [new PrConfirmHook(host), new PrProseHook(host), new StripAiCoauthorsHook(host)],
                error
            );
            var args = StringArray("args").Select(arg => arg.Replace("$CWD", root, StringComparison.Ordinal)).ToArray();
            using var stdin = new MemoryStream(Encoding.UTF8.GetBytes(StdinText(root)));
            var exit = await engine.RunAsync(_case.GetProperty("hook").GetString()!, args, stdin, CancellationToken.None);
            return new PrRun(exit, output.ToString(), error.ToString(), Snapshot(root));
        }
        finally
        {
            System.IO.Directory.Delete(root, recursive: true);
        }
    }

    private Dictionary<string, string?> BuildEnv(string root)
    {
        Dictionary<string, string?> env = new(StringComparer.Ordinal)
        {
            ["HOME"] = Path.Combine(root, "home"),
            ["TMPDIR"] = Path.Combine(root, "work"),
            ["DG_HOME"] = Path.Combine(root, "home"),
            ["DG_PATH_FENCE"] = root,
            ["AI_SCRATCH_DIR"] = Path.Combine(root, "scratch"),
            ["PATH"] = Path.Combine(root, "bin"),
        };
        if (_case.TryGetProperty("env", out var extra))
            foreach (var entry in extra.EnumerateObject())
                env[entry.Name] = Substitute(entry.Value.GetString()!, root);
        return env;
    }

    private void Plant(string root)
    {
        if (_case.TryGetProperty("files", out var files))
            foreach (var entry in files.EnumerateObject())
            {
                var target = Path.Combine(root, entry.Name.TrimEnd('/'));
                if (entry.Name.EndsWith('/'))
                {
                    System.IO.Directory.CreateDirectory(target);
                    continue;
                }
                System.IO.Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                if (entry.Value.ValueKind == JsonValueKind.String)
                    File.WriteAllBytes(target, Encoding.UTF8.GetBytes(Substitute(entry.Value.GetString()!, root)));
                else
                    File.WriteAllBytes(target, Convert.FromBase64String(entry.Value.GetProperty("base64").GetString()!));
            }
        if (_case.TryGetProperty("bin", out var bin))
            foreach (var entry in bin.EnumerateObject())
            {
                var target = Path.Combine(root, "bin", entry.Name);
                File.WriteAllText(target, entry.Value.GetString()!);
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(target, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
    }

    private void WriteConfig(string root, Dictionary<string, string?> env)
    {
        if (!_case.TryGetProperty("config", out var config))
            return;
        var file = DgPaths.Resolve(DgPathSeams.Current(env)).Value!.ConfigTomlPath;
        System.IO.Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, config.GetString()!);
    }

    private string StdinText(string root)
    {
        if (_case.TryGetProperty("stdin", out var raw))
            return raw.GetString()!;
        if (_case.TryGetProperty("event", out var ev))
            return Substitute(ev.GetRawText(), root);
        if (_case.TryGetProperty("cwd", out var cwd))
            return $"{{\"cwd\":\"{JsonEncodedText.Encode(Path.Combine(root, cwd.GetString()!))}\"}}";
        return "";
    }

    private IEnumerable<string> StringArray(string name) =>
        _case.TryGetProperty(name, out var values) ? values.EnumerateArray().Select(value => value.GetString()!) : [];

    private static string Substitute(string text, string root) =>
        text.Replace("$CWD", JsonEncodedRoot(text, root), StringComparison.Ordinal);

    private static string JsonEncodedRoot(string text, string root) =>
        text.TrimStart().StartsWith('{') ? JsonEncodedText.Encode(root).ToString() : root;

    private static SortedDictionary<string, string> Snapshot(string root)
    {
        SortedDictionary<string, string> files = new(StringComparer.Ordinal);
        Walk(root, root, files);
        return files;
    }

    private static void Walk(string root, string current, SortedDictionary<string, string> files)
    {
        foreach (var directory in System.IO.Directory.GetDirectories(current))
            if (Path.GetFileName(directory) is not (".git" or "home" or "bin"))
                Walk(root, directory, files);
        foreach (var file in System.IO.Directory.GetFiles(current))
        {
            var bytes = File.ReadAllBytes(file);
            string text;
            try
            {
                text = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                text = $"base64:{Convert.ToBase64String(bytes)}";
            }
            files[Path.GetRelativePath(root, file).Replace('\\', '/')] = text;
        }
    }

    private static string Folder([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}

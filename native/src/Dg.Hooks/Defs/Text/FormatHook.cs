using System.Security.Cryptography;
using System.Text;
using Dg.Hooks.Engine;
using Dg.Hooks.Shared;

namespace Dg.Hooks.Defs.Text;

internal sealed class FormatHook(TextHookIo? injected = null) : IHook
{
    private readonly HashSet<string> _warned = new(StringComparer.Ordinal);

    public string Id => "format";

    public async ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
    {
        var io = injected ?? TextHookIo.Process();
        var runtime = new HookRuntime(io, ev, _warned);
        if (ev.ToolName is not ("Edit" or "Write" or "MultiEdit"))
            return 0;
        if (string.IsNullOrEmpty(ev.FilePath))
            return 0;
        var cwd = Path.GetFullPath(ev.Cwd ?? Directory.GetCurrentDirectory());
        var file = ResolveFile(cwd, ev.FilePath);
        if (!File.Exists(file) && !Directory.Exists(file))
            return 0;

        Formatting formatting = new(file, runtime, ct);
        await formatting.RunAsync().ConfigureAwait(false);
        var fresh = FirstWarnings(runtime, formatting.Missing);
        List<string> notes = [.. formatting.Failed.Select(failure => $"format: {failure}")];
        if (fresh.Count > 0)
            notes.Add(
                $"format: NOT FORMATTED - formatter unavailable: {string.Join(' ', fresh)}. Matching files were skipped, not formatted."
            );
        if (notes.Count == 0)
            return 0;
        HookJson.EmitContext(ev, "PostToolUse", string.Join('\n', notes), text => io.Out.Write(text));
        return 0;
    }

    private static string ResolveFile(string cwd, string raw)
    {
        var full = Path.GetFullPath(raw, cwd);
        return Path.GetPathRoot(full) == full ? full : Path.TrimEndingDirectorySeparator(full);
    }

    private static List<string> FirstWarnings(HookRuntime runtime, List<string> tools)
    {
        ManagedRoots.EnsurePrivateDirectory(runtime.ScratchDir);
        List<string> fresh = [];
        foreach (var tool in tools)
        {
            var marker = Path.Combine(runtime.ScratchDir, $"fmt-warned.{runtime.SessionId}.{tool}");
            if (File.Exists(marker))
                continue;
            File.WriteAllText(marker, "");
            fresh.Add(tool);
        }
        return fresh;
    }

    private sealed class Formatting(string file, HookRuntime runtime, CancellationToken ct)
    {
        private static readonly Dictionary<string, (string Bin, string[] Before)> Simple = new(StringComparer.Ordinal)
        {
            ["py"] = ("ruff", ["format", "--quiet"]),
            ["go"] = ("gofmt", ["-w"]),
            ["tf"] = ("terraform", ["fmt"]),
            ["lua"] = ("stylua", []),
            ["dart"] = ("dart", ["format"]),
            ["bzl"] = ("black", ["--quiet"]),
        };

        private static readonly string[] BazelFiles = ["BUILD", "BUILD.bazel", "WORKSPACE", "WORKSPACE.bazel"];

        public List<string> Missing { get; } = [];

        public List<string> Failed { get; } = [];

        private IReadOnlyDictionary<string, string?> Env => runtime.Io.Env;

        public async Task RunAsync()
        {
            var ext = Extension(file);
            var name = Path.GetFileName(file);
            if (Simple.TryGetValue(ext, out var simple))
            {
                if (Have(simple.Bin))
                    await ExecAsync([simple.Bin, .. simple.Before, file]).ConfigureAwait(false);
            }
            else if (ext == "cs")
                await CSharpierAsync().ConfigureAwait(false);
            else if (ext == "json")
                await JsonAsync().ConfigureAwait(false);
            else if (ext is "js" or "jsx" or "ts" or "tsx")
            {
                if (!await BiomeAsync(fix: true).ConfigureAwait(false))
                    AddMissing("biome");
            }
            else if (ext is "sh" or "bash")
                await ShellAsync().ConfigureAwait(false);
            else if (ext == "md")
                await MarkdownAsync().ConfigureAwait(false);
            else if (ext == "xml")
                await XmlAsync().ConfigureAwait(false);
            else if (ext is "html" or "htm")
                await HtmlAsync().ConfigureAwait(false);
            else if (ext == "conf" && name.Contains("nginx", StringComparison.Ordinal))
            {
                if (Have("nginx_beautifier"))
                    await ExecAsync(["nginx_beautifier", file]).ConfigureAwait(false);
            }
            if (Array.IndexOf(BazelFiles, name) >= 0 && Have("black"))
                await ExecAsync(["black", "--quiet", file]).ConfigureAwait(false);
        }

        private static string Extension(string path)
        {
            var name = Path.GetFileName(path);
            var dot = name.LastIndexOf('.');
            return dot <= 0 ? "" : name[(dot + 1)..];
        }

        private void AddMissing(string bin)
        {
            if (!Missing.Contains(bin))
                Missing.Add(bin);
        }

        private string? Which(string bin) => HookProcess.Which(bin, Env);

        private bool Have(string bin)
        {
            if (Which(bin) is not null)
                return true;
            AddMissing(bin);
            return false;
        }

        private Task<CommandResult> ProbeAsync(string[] argv, string? cwd = null) =>
            HookProcess.RunAsync(Env, argv, cwd, ct);

        private async Task<CommandResult> ExecAsync(string[] argv, string? cwd = null)
        {
            var result = await ProbeAsync(argv, cwd).ConfigureAwait(false);
            if (result.Status != 0)
            {
                var reason = result.Stderr.Trim().Split('\n', 2)[0];
                Failed.Add(
                    $"{Path.GetFileName(argv[0])} failed (status {result.Status}){(reason.Length > 0 ? $": {reason}" : "")}"
                );
            }
            return result;
        }

        private IEnumerable<string> Ancestors()
        {
            for (var dir = Path.GetDirectoryName(file); dir is not null; )
            {
                var parent = Path.GetDirectoryName(dir);
                if (parent is null || parent == dir)
                    yield break;
                yield return dir;
                dir = parent;
            }
        }

        private bool IsBoundary(string dir) =>
            (Env.TryGetValue("HOME", out var home) && home is not null && dir == home)
            || Exists(Path.Combine(dir, ".git"));

        private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

        private static string Sha1(string text) =>
            Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(text)));

        private void WriteMarker(string marker, bool value)
        {
            ManagedRoots.EnsurePrivateDirectory(runtime.ScratchDir);
            File.WriteAllText(marker, value ? "1" : "0");
        }

        private static bool? ReadMarker(string marker)
        {
            try
            {
                return File.ReadAllText(marker) == "1";
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }

        private async Task<bool> BiomeIsRealAsync(string bin)
        {
            var marker = Path.Combine(runtime.ScratchDir, $"biome-real.{Sha1(bin)}");
            if (ReadMarker(marker) is { } cached)
                return cached;
            var probe = await ProbeAsync([bin, "--version"]).ConfigureAwait(false);
            var real =
                probe.Stdout.Contains("Biome", StringComparison.Ordinal)
                || probe.Stdout.Contains("Version:", StringComparison.Ordinal);
            WriteMarker(marker, real);
            return real;
        }

        private async Task<(string Bin, string? ConfigDir)?> ResolveBiomeAsync()
        {
            string? bin = null;
            string? configDir = null;
            foreach (var dir in Ancestors())
            {
                var local = Path.Combine(dir, "node_modules", ".bin", "biome");
                if (bin is null && Exists(local))
                    bin = local;
                if (
                    configDir is null
                    && (Exists(Path.Combine(dir, "biome.json")) || Exists(Path.Combine(dir, "biome.jsonc")))
                )
                    configDir = dir;
                if (IsBoundary(dir))
                    break;
            }
            if (bin is null && Which("biome") is not null && await BiomeIsRealAsync("biome").ConfigureAwait(false))
                bin = "biome";
            return bin is null ? null : (bin, configDir);
        }

        private async Task<bool> SupportsOrganizeAsync(string bin, string? configDir)
        {
            var marker = Path.Combine(runtime.ScratchDir, $"biome-organize.{Sha1(bin)}");
            if (ReadMarker(marker) is { } cached)
                return cached;
            var help = await ProbeAsync([bin, "check", "--help"], configDir).ConfigureAwait(false);
            var organize = (help.Stdout + help.Stderr).Contains("--organize-imports-enabled", StringComparison.Ordinal);
            WriteMarker(marker, organize);
            return organize;
        }

        private async Task<bool> BiomeAsync(bool fix)
        {
            if (await ResolveBiomeAsync().ConfigureAwait(false) is not var (bin, configDir))
                return false;
            var formatted = await ExecAsync([bin, "format", "--write", file], configDir).ConfigureAwait(false);
            if (fix && formatted.Status == 0)
            {
                var organize = await SupportsOrganizeAsync(bin, configDir).ConfigureAwait(false);
                await ExecAsync(
                        organize
                            ? [bin, "check", "--fix", "--organize-imports-enabled=true", file]
                            : [bin, "check", "--fix", file],
                        configDir
                    )
                    .ConfigureAwait(false);
            }
            return true;
        }

        private async Task FormatToStdoutAsync(string bin, string[] argv)
        {
            var target = File.ResolveLinkTarget(file, returnFinalTarget: true)?.FullName ?? file;
            var before = await File.ReadAllBytesAsync(target, ct).ConfigureAwait(false);
            var result = await ExecAsync(argv).ConfigureAwait(false);
            if (result.Status != 0 || result.Stdout.Length == 0)
                return;
            if (result.Truncated)
            {
                Failed.Add($"{bin} output was incomplete, so the file was left unchanged");
                return;
            }
            var now = await File.ReadAllBytesAsync(target, ct).ConfigureAwait(false);
            if (!now.AsSpan().SequenceEqual(before))
            {
                Failed.Add($"{file} changed while {bin} ran, so the formatted output was not written");
                return;
            }
            WriteAtomic(target, Encoding.UTF8.GetBytes(result.Stdout));
        }

        private static void WriteAtomic(string path, byte[] data)
        {
            var unix = !OperatingSystem.IsWindows();
            var temp = $"{path}.{Environment.ProcessId}.{Guid.NewGuid()}.tmp";
            try
            {
                File.WriteAllBytes(temp, data);
                if (unix)
                    File.SetUnixFileMode(temp, File.GetUnixFileMode(path));
                File.Move(temp, path, overwrite: true);
            }
            catch
            {
                File.Delete(temp);
                throw;
            }
        }

        private async Task CSharpierAsync()
        {
            foreach (var dir in Ancestors())
            {
                var tools = Path.Combine(dir, ".config", "dotnet-tools.json");
                if (
                    File.Exists(tools)
                    && (await File.ReadAllTextAsync(tools, ct).ConfigureAwait(false)).Contains("\"csharpier\"", StringComparison.Ordinal)
                )
                {
                    await ExecAsync(["dotnet", "tool", "run", "csharpier", "--", "format", file], dir)
                        .ConfigureAwait(false);
                    return;
                }
                if (IsBoundary(dir))
                    break;
            }
            if (Have("csharpier"))
                await ExecAsync(["csharpier", "format", file]).ConfigureAwait(false);
        }

        private async Task JsonAsync()
        {
            if (await BiomeAsync(fix: false).ConfigureAwait(false))
                return;
            if (Which("jq") is null)
                return;
            await FormatToStdoutAsync("jq", ["jq", ".", file]).ConfigureAwait(false);
        }

        private async Task ShellAsync()
        {
            if (!Have("shfmt"))
                return;
            var head = new byte[256];
            int read;
            using (var stream = File.OpenRead(file))
                read = await stream.ReadAsync(head, ct).ConfigureAwait(false);
            var text = Encoding.UTF8.GetString(head, 0, read);
            var newline = text.IndexOf('\n', StringComparison.Ordinal);
            if ((newline < 0 ? text : text[..newline]).Contains("zsh", StringComparison.Ordinal))
                return;
            await ExecAsync(["shfmt", "-i", "2", "-w", file]).ConfigureAwait(false);
        }

        private async Task MarkdownAsync()
        {
            var scratch = runtime.Env("AI_SCRATCH_DIR") ?? "/tmp/ai";
            var normalized = file.Replace('\\', '/');
            if (MarkdownSkip.Matches(normalized) || normalized.StartsWith($"{scratch}/", StringComparison.Ordinal))
                return;
            var home = runtime.Env("HOME");
            var localBin = home is null ? null : Path.Combine(home, ".local", "bin", "mdformat");
            if (localBin is not null && Exists(localBin))
                await ExecAsync([localBin, file]).ConfigureAwait(false);
            else if (Have("mdformat"))
                await ExecAsync(["mdformat", file]).ConfigureAwait(false);
            if (Which("markdownlint") is not null)
                await ExecAsync(["markdownlint", "--fix", file]).ConfigureAwait(false);
        }

        private async Task XmlAsync()
        {
            if (Which("xmlformat") is not null)
                await FormatToStdoutAsync("xmlformat", ["xmlformat", file]).ConfigureAwait(false);
            else if (Which("xmlformatter") is not null)
                await ExecAsync(["xmlformatter", "--overwrite", file]).ConfigureAwait(false);
            else
                AddMissing("xmlformat");
        }

        private async Task HtmlAsync()
        {
            if (Which("superhtml") is not null)
                await ExecAsync(["superhtml", "fmt", file]).ConfigureAwait(false);
            else if (!await BiomeAsync(fix: false).ConfigureAwait(false))
                AddMissing("superhtml");
        }
    }
}

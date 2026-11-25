using System.Globalization;
using Dg.Core.Config;
using Dg.Core.Paths;
using Dg.Hooks.Engine;

namespace Dg.Hooks.Defs.Text;

internal sealed class HookRuntime
{
    private readonly HashSet<string> _warned;
    private readonly string _markerSession;

    public HookRuntime(TextHookIo io, HookEvent ev, HashSet<string> warned)
    {
        Io = io;
        _warned = warned;
        _markerSession = Sanitize(Env("CLAUDE_CODE_SESSION_ID") ?? Env("CLAUDE_SESSION_ID") ?? "NOSESSION");
        SessionId = Sanitize(
            Env("CLAUDE_CODE_SESSION_ID")
                ?? Env("CLAUDE_SESSION_ID")
                ?? Env("CODEX_THREAD_ID")
                ?? (string.IsNullOrEmpty(ev.SessionId) ? null : ev.SessionId)
                ?? "NOSESSION"
        );
        ScratchDir = ResolveScratch(io.Env);
    }

    public TextHookIo Io { get; }

    public string SessionId { get; }

    public string ScratchDir { get; }

    public string? Env(string name) =>
        Io.Env.TryGetValue(name, out var value) && !string.IsNullOrEmpty(value) ? value : null;

    public bool Bypassed(string name) =>
        File.Exists(Path.Combine(ScratchDir, $"{name}.{SessionId}"))
        || File.Exists(Path.Combine(ScratchDir, $"{name}.{_markerSession}"));

    public double Number(string name, double fallback) =>
        Env(name) is { } text && JsNumber.TryParse(text, out var value) && double.IsFinite(value)
            ? value
            : fallback;

    public string Setting(string hookId, string key, string[] values)
    {
        var fallback = values[0];
        var result = LoadConfig();
        if (!result.IsOk)
        {
            Warn(
                $"hooks: dg config is unreadable ({ConfigErrorText.Render(result.Error!)}); using {fallback} for {hookId}.{key}\n"
            );
            return fallback;
        }
        if (
            result.Value is not { } toml
            || !toml.Hooks.TryGetValue(hookId, out var table)
            || !table.TryGetValue(key, out var value)
        )
            return fallback;
        foreach (var candidate in values)
        {
            if (string.Equals(candidate, value, StringComparison.OrdinalIgnoreCase))
                return candidate;
        }
        Warn(
            $"hooks: {hookId}.{key} is {HookJson.Quote(value)} but must be one of {string.Join(", ", values)}; using {fallback}\n"
        );
        return fallback;
    }

    private ConfigResult<DgToml?> LoadConfig()
    {
        var paths = DgPaths.Resolve(DgPathSeams.Current(Io.Env));
        if (!paths.IsOk)
            return ConfigResult<DgToml?>.Fail(paths.Error!);
        var file = paths.Value!.ConfigTomlPath;
        if (!File.Exists(file))
            return ConfigResult<DgToml?>.Ok(null);
        var parsed = DgConfig.Parse(File.ReadAllText(file), file);
        return parsed.IsOk
            ? ConfigResult<DgToml?>.Ok(parsed.Value)
            : ConfigResult<DgToml?>.Fail(parsed.Error!);
    }

    private void Warn(string message)
    {
        if (_warned.Add(message))
            Io.Err.Write(message);
    }

    private static string Sanitize(string raw)
    {
        Span<char> buffer = raw.Length <= 128 ? stackalloc char[raw.Length] : new char[raw.Length];
        for (var i = 0; i < raw.Length; i++)
        {
            var c = raw[i];
            buffer[i] = c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '_' or '-'
                ? c
                : '_';
        }
        return new string(buffer);
    }

    private static string ResolveScratch(IReadOnlyDictionary<string, string?> env)
    {
        var configured = env.TryGetValue("AI_SCRATCH_DIR", out var value) && !string.IsNullOrEmpty(value) ? value : null;
        var root = Path.GetFullPath(configured ?? "/tmp/ai");
        var child = Path.Combine(root, "hooks");
        try
        {
            EnsurePrivateDirectory(root);
            if (IsLink(root) && configured is null)
                throw Unsafe(root);
            CheckDirectory(root);
            EnsurePrivateDirectory(child);
        }
        catch (IOException)
        {
            throw Unsafe(root);
        }
        if (IsLink(child))
            throw Unsafe(child);
        CheckDirectory(child);
        return child;
    }

    public static void EnsurePrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
            Directory.CreateDirectory(path);
        else
            Directory.CreateDirectory(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            );
    }

    private static bool IsLink(string path) => new DirectoryInfo(path).LinkTarget is not null;

    private static void CheckDirectory(string path)
    {
        if (!Directory.Exists(path))
            throw Unsafe(path);
        if (
            !OperatingSystem.IsWindows()
            && (File.GetUnixFileMode(path) & (UnixFileMode.GroupWrite | UnixFileMode.OtherWrite)) != 0
        )
            throw Unsafe(path);
    }

    private static InvalidOperationException Unsafe(string path) =>
        new($"unsafe scratch/state directory: {path}");
}

internal static class JsNumber
{
    public static bool TryParse(string text, out double value)
    {
        var trimmed = text.AsSpan().Trim();
        if (trimmed.IsEmpty)
        {
            value = 0;
            return true;
        }
        if (trimmed.Length > 2 && trimmed[0] == '0' && Radix(trimmed[1]) is { } radix)
            return TryParseRadix(trimmed[2..], radix, out value);
        return double.TryParse(
            trimmed,
            NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint | NumberStyles.AllowExponent,
            CultureInfo.InvariantCulture,
            out value
        );
    }

    private static int? Radix(char c) =>
        c switch
        {
            'x' or 'X' => 16,
            'o' or 'O' => 8,
            'b' or 'B' => 2,
            _ => null,
        };

    private static bool TryParseRadix(ReadOnlySpan<char> digits, int radix, out double value)
    {
        value = 0;
        foreach (var c in digits)
        {
            var digit = c switch
            {
                >= '0' and <= '9' => c - '0',
                >= 'a' and <= 'f' => c - 'a' + 10,
                >= 'A' and <= 'F' => c - 'A' + 10,
                _ => int.MaxValue,
            };
            if (digit >= radix)
                return false;
            value = (value * radix) + digit;
        }
        return true;
    }
}

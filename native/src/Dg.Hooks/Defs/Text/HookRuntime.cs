using Dg.Core.Config;
using Dg.Core.Paths;
using Dg.Hooks.Engine;
using Dg.Hooks.Shared;

namespace Dg.Hooks.Defs.Text;

internal sealed class HookRuntime
{
    private readonly HashSet<string> _warned;
    private readonly HookEnvironment _vars;
    private readonly string _markerSession;

    public HookRuntime(TextHookIo io, HookEvent ev, HashSet<string> warned)
    {
        Io = io;
        _warned = warned;
        _vars = new HookEnvironment(io.Env);
        _markerSession = _vars.MarkerSession();
        SessionId = _vars.SessionOf(ev.SessionId);
        ScratchDir = HookDirectories.For(io.Env).Scratch();
    }

    public TextHookIo Io { get; }

    public string SessionId { get; }

    public string ScratchDir { get; }

    public string? Env(string name) => _vars.First(name);

    public bool Bypassed(string name) =>
        File.Exists(Path.Combine(ScratchDir, $"{name}.{SessionId}"))
        || File.Exists(Path.Combine(ScratchDir, $"{name}.{_markerSession}"));

    public double Number(string name, double fallback) => _vars.Number(name, fallback);

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
}

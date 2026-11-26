using Dg.Core.Config;
using Dg.Core.Errors;

namespace Dg.Core.Paths;

public sealed record DgPathSeams(
    DgPlatform Platform,
    string HomeDir,
    string Cwd,
    IReadOnlyDictionary<string, string?> Env
)
{
    public static DgPathSeams Current(IReadOnlyDictionary<string, string?> env) =>
        new(
            OperatingSystem.IsWindows() ? DgPlatform.Windows
                : OperatingSystem.IsMacOS() ? DgPlatform.MacOs
                : DgPlatform.Linux,
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            Directory.GetCurrentDirectory(),
            env
        );
}

public sealed record DgPaths
{
    public required string BinDir { get; init; }
    public required string ConfigDir { get; init; }
    public required string DataDir { get; init; }
    public required string StateDir { get; init; }
    public required string CacheDir { get; init; }
    public required string LogDir { get; init; }
    public required string ConfigPath { get; init; }
    public required string ConfigTomlPath { get; init; }
    public required string ExecAllowlistPath { get; init; }
    public required string CliOnlyMarker { get; init; }
    public required string RuntimeDir { get; init; }
    public required string LibDir { get; init; }
    public required string BrowsersDir { get; init; }
    public required string SkillsDir { get; init; }
    public required string PersonasDir { get; init; }
    public required string DaemonDir { get; init; }
    public required string PidPath { get; init; }
    public required string DbPath { get; init; }
    public required string CredentialsDbPath { get; init; }
    public required string KeyPath { get; init; }
    public required string DaemonConfigPath { get; init; }
    public required string AgentsDir { get; init; }
    public required string SessionsDir { get; init; }
    public required string AssetsDir { get; init; }
    public required string MemoryDbPath { get; init; }
    public required string GrantsDir { get; init; }
    public required string PhoneRoot { get; init; }
    public required string PhoneFriendRoot { get; init; }
    public required string JobsDir { get; init; }
    public required string JobSourcesPath { get; init; }
    public required string JobStateRoot { get; init; }
    public required string LegacyHome { get; init; }

    public static ConfigResult<DgPaths> Resolve(DgPathSeams seams)
    {
        ArgumentNullException.ThrowIfNull(seams);
        var flavor = PathFlavor.For(seams.Platform);
        var paths = Compute(seams, flavor);
        return Fence(seams, flavor, paths) is { } error
            ? ConfigResult<DgPaths>.Fail(error)
            : ConfigResult<DgPaths>.Ok(paths);
    }

    private static string? Env(IReadOnlyDictionary<string, string?> env, string name) =>
        env.TryGetValue(name, out var value) && !string.IsNullOrEmpty(value) ? value : null;

    private static (string Bin, string Config, string Data, string State, string Cache, string Log) Roots(
        DgPathSeams seams,
        PathFlavor path
    )
    {
        var home = seams.HomeDir;
        if (Env(seams.Env, "DG_HOME") is { } dgHome)
        {
            var root = path.Resolve(dgHome, seams.Cwd);
            return (
                path.Join(root, "bin"),
                path.Join(root, "config"),
                path.Join(root, "data"),
                path.Join(root, "state"),
                path.Join(root, "cache"),
                path.Join(root, "log")
            );
        }
        if (seams.Platform == DgPlatform.Windows)
        {
            var local = path.Join(
                Env(seams.Env, "LOCALAPPDATA") ?? path.Join(home, "AppData", "Local"),
                "dg"
            );
            return (
                path.Join(local, "bin"),
                path.Join(Env(seams.Env, "APPDATA") ?? path.Join(home, "AppData", "Roaming"), "dg"),
                local,
                path.Join(local, "state"),
                path.Join(local, "cache"),
                path.Join(local, "log")
            );
        }
        if (seams.Platform == DgPlatform.MacOs)
        {
            var support = path.Join(home, "Library", "Application Support", "dg");
            return (
                path.Join(home, ".local", "bin"),
                support,
                support,
                path.Join(support, "state"),
                path.Join(home, "Library", "Caches", "dg"),
                path.Join(home, "Library", "Logs", "dg")
            );
        }
        string Xdg(string name, params ReadOnlySpan<string> fallback)
        {
            var root = Env(seams.Env, name);
            if (root is null || !path.IsAbsolute(root))
                root = path.Join([home, .. fallback]);
            return path.Join(root, "dg");
        }
        var state = Xdg("XDG_STATE_HOME", ".local", "state");
        return (
            path.Join(home, ".local", "bin"),
            Xdg("XDG_CONFIG_HOME", ".config"),
            Xdg("XDG_DATA_HOME", ".local", "share"),
            state,
            Xdg("XDG_CACHE_HOME", ".cache"),
            path.Join(state, "log")
        );
    }

    private static DgPaths Compute(DgPathSeams seams, PathFlavor path)
    {
        var (bin, config, data, state, cache, log) = Roots(seams, path);
        var daemon = path.Join(state, "daemon");
        var agents = path.Join(state, "agents");
        var jobs = path.Join(data, "jobs");
        var legacy = Env(seams.Env, "DG_HOME") is { } dgHome
            ? path.Resolve(dgHome, seams.Cwd)
            : seams.Platform == DgPlatform.Windows
                ? path.Join(Env(seams.Env, "USERPROFILE") ?? seams.HomeDir, ".dg")
                : path.Join(seams.HomeDir, ".dg");
        return new DgPaths
        {
            BinDir = bin,
            ConfigDir = config,
            DataDir = data,
            StateDir = state,
            CacheDir = cache,
            LogDir = log,
            ConfigPath = path.Join(config, "config.json"),
            ConfigTomlPath = path.Join(config, "config.toml"),
            ExecAllowlistPath = path.Join(config, "exec-allowlist"),
            CliOnlyMarker = path.Join(config, "cli-only"),
            RuntimeDir = path.Join(data, "runtime"),
            LibDir = path.Join(data, "lib"),
            BrowsersDir = path.Join(data, "browsers"),
            SkillsDir = path.Join(data, "skills"),
            PersonasDir = path.Join(data, "agents"),
            DaemonDir = daemon,
            PidPath = path.Join(daemon, "daemon.pid"),
            DbPath = path.Join(daemon, "daemon.db"),
            CredentialsDbPath = path.Join(daemon, "credentials.db"),
            KeyPath = path.Join(daemon, "key"),
            DaemonConfigPath = path.Join(daemon, "config.json"),
            AgentsDir = agents,
            SessionsDir = path.Join(agents, "sessions"),
            AssetsDir = path.Join(agents, "assets"),
            MemoryDbPath = path.Join(agents, "memory.db"),
            GrantsDir = path.Join(state, "grants"),
            PhoneRoot = path.Join(state, "phone"),
            PhoneFriendRoot = path.Join(state, "phone-friend"),
            JobsDir = jobs,
            JobSourcesPath = path.Join(jobs, "sources.json"),
            JobStateRoot = path.Join(state, "jobs"),
            LegacyHome = legacy,
        };
    }

    private static DgError? Fence(DgPathSeams seams, PathFlavor path, DgPaths paths)
    {
        if (Env(seams.Env, "DG_PATH_FENCE") is not { } fence)
            return null;
        if (!path.IsAbsolute(fence))
            return new DgError("", null, "DG_PATH_FENCE", $"dg path fence: {fence} is not absolute", "");
        string[] bases = [fence, RealOrGiven(fence)];
        (string Role, string Path)[] roles =
        [
            ("binDir", paths.BinDir),
            ("configDir", paths.ConfigDir),
            ("dataDir", paths.DataDir),
            ("stateDir", paths.StateDir),
            ("cacheDir", paths.CacheDir),
            ("logDir", paths.LogDir),
            ("legacyHome", paths.LegacyHome),
        ];
        foreach (var (role, target) in roles)
        {
            if (Inside(path, bases, target))
                continue;
            return new DgError(
                "",
                null,
                role,
                $"dg path fence: {role} {target} is outside {fence} (unset DG_PATH_FENCE to turn the fence off)",
                ""
            );
        }
        return null;
    }

    private static bool Inside(PathFlavor path, string[] bases, string target)
    {
        var right = path.Normalize(target);
        if (path.Windows)
            right = right.ToLowerInvariant();
        foreach (var root in bases)
        {
            var left = path.Normalize(root);
            if (path.Windows)
                left = left.ToLowerInvariant();
            var prefix = left.EndsWith(path.Separator) ? left : left + path.Separator;
            if (right == left || right.StartsWith(prefix, StringComparison.Ordinal))
                return true;
        }
        return false;
    }

    private static string RealOrGiven(string value)
    {
        try
        {
            return new DirectoryInfo(value).ResolveLinkTarget(true)?.FullName ?? value;
        }
        catch (IOException)
        {
            return value;
        }
    }
}

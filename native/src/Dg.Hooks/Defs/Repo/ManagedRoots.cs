namespace Dg.Hooks.Defs.Repo;

internal static class ManagedRoots
{
    private const UnixFileMode OthersCanWrite = UnixFileMode.GroupWrite | UnixFileMode.OtherWrite;
    private const UnixFileMode OwnerOnly =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    public static bool IsSet(Func<string, string?> env, string name) => !string.IsNullOrEmpty(env(name));

    public static string Scratch(Func<string, string?> env) =>
        IsSet(env, "AI_SCRATCH_DIR") ? env("AI_SCRATCH_DIR")! : "/tmp/ai";

    public static string State(Func<string, string?> env, string home)
    {
        if (IsSet(env, "AI_STATE_DIR"))
            return env("AI_STATE_DIR")!;
        var xdg = IsSet(env, "XDG_STATE_HOME") ? env("XDG_STATE_HOME")! : Path.Join(home, ".local", "state");
        return Path.Join(xdg, "ai");
    }

    public static void AssertSafe(string basePath, bool allowRootLink)
    {
        var root = Path.GetFullPath(basePath);
        if (Path.GetDirectoryName(root) is { } parent)
            SafeAncestors(parent);
        var entry = DirectoryEntry(root);
        if (entry.IsLink)
        {
            if (!allowRootLink)
                Unsafe(root);
            SafeAncestors(FsPaths.RealPath(root));
        }
        if (!Directory.Exists(root) || OthersCanWriteTo(root))
            Unsafe(root);
    }

    public static string PrivateChild(string basePath, string name, bool allowRootLink)
    {
        AssertSafe(basePath, allowRootLink);
        var dir = Path.Join(Path.GetFullPath(basePath), name);
        var entry = DirectoryEntry(dir);
        if (entry.IsLink || !entry.IsDirectory || OthersCanWriteTo(dir))
            Unsafe(dir);
        return dir;
    }

    private static void SafeAncestors(string dir)
    {
        var parent = Path.GetDirectoryName(dir);
        if (parent is not null && parent != dir)
            SafeAncestors(parent);
        var entry = DirectoryEntry(dir);
        if (entry.IsLink)
        {
            SafeAncestors(FsPaths.RealPath(dir));
            return;
        }
        if (!entry.IsDirectory)
            Unsafe(dir);
        if (!OperatingSystem.IsWindows())
        {
            var mode = File.GetUnixFileMode(dir);
            if ((mode & OthersCanWrite) != 0 && (mode & UnixFileMode.StickyBit) == 0)
                Unsafe(dir);
        }
    }

    private static Lstat DirectoryEntry(string dir)
    {
        if (FsPaths.TryLstat(dir) is { } existing)
            return existing;
        if (OperatingSystem.IsWindows())
            Directory.CreateDirectory(dir);
        else
            Directory.CreateDirectory(dir, OwnerOnly);
        return FsPaths.TryLstat(dir) ?? throw new IOException($"cannot create {dir}");
    }

    private static bool OthersCanWriteTo(string dir) =>
        !OperatingSystem.IsWindows() && (File.GetUnixFileMode(dir) & OthersCanWrite) != 0;

    private static void Unsafe(string dir) =>
        throw new InvalidOperationException($"unsafe scratch/state directory: {dir}");
}

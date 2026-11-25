namespace Dg.Hooks.Shared;

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
        var uid = FileOwner.CurrentUser;
        var systemUid = uid is null ? 0 : FileOwner.Of(Path.GetPathRoot(root)!, follow: false);
        if (Path.GetDirectoryName(root) is { } parent)
            SafeAncestors(parent, uid, systemUid);
        var entry = EnsureEntry(root);
        if (entry.IsLink)
        {
            if (!allowRootLink || (uid is not null && FileOwner.Of(root, follow: false) != uid))
                Unsafe(root);
            SafeAncestors(FsPaths.RealPath(root), uid, systemUid);
        }
        if (!Directory.Exists(root) || !OwnedPrivately(root, uid, follow: true))
            Unsafe(root);
    }

    public static string PrivateChild(string basePath, string name, bool allowRootLink)
    {
        AssertSafe(basePath, allowRootLink);
        var dir = Path.Join(Path.GetFullPath(basePath), name);
        var entry = EnsureEntry(dir);
        if (entry.IsLink || !entry.IsDirectory || !OwnedPrivately(dir, FileOwner.CurrentUser, follow: false))
            Unsafe(dir);
        return dir;
    }

    public static void EnsurePrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
            Directory.CreateDirectory(path);
        else
            Directory.CreateDirectory(path, OwnerOnly);
    }

    private static void SafeAncestors(string dir, uint? uid, uint systemUid)
    {
        var parent = Path.GetDirectoryName(dir);
        if (parent is not null && parent != dir)
            SafeAncestors(parent, uid, systemUid);
        if (FsPaths.TryLstat(dir) is not { } entry)
            return;
        if (uid is { } self && FileOwner.Of(dir, follow: false) is var owner && owner != self && owner != 0 && owner != systemUid)
            Unsafe(dir);
        if (entry.IsLink)
        {
            SafeAncestors(FsPaths.RealPath(dir), uid, systemUid);
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

    private static bool OwnedPrivately(string dir, uint? uid, bool follow) =>
        OperatingSystem.IsWindows()
        || uid is not { } self
        || (FileOwner.Of(dir, follow) == self && (File.GetUnixFileMode(dir) & OthersCanWrite) == 0);

    private static Lstat EnsureEntry(string dir)
    {
        if (FsPaths.TryLstat(dir) is { } existing)
            return existing;
        try
        {
            EnsurePrivateDirectory(dir);
        }
        catch (IOException) when (Directory.Exists(dir)) { }
        return FsPaths.TryLstat(dir) ?? throw new IOException($"cannot create {dir}");
    }

    private static void Unsafe(string dir) =>
        throw new InvalidOperationException($"unsafe scratch/state directory: {dir}");
}

namespace Dg.Hooks.Defs.Pr;

internal static class ScratchDirectory
{
    private const string DefaultRoot = "/tmp/ai";

    public static string Hooks(IReadOnlyDictionary<string, string?> env)
    {
        var configured = env.TryGetValue("AI_SCRATCH_DIR", out var value) && !string.IsNullOrEmpty(value);
        var root = Path.GetFullPath(configured ? value! : DefaultRoot);
        Ensure(root, configured);
        var hooks = Path.Combine(root, "hooks");
        Ensure(hooks, false);
        return hooks;
    }

    private static void Ensure(string path, bool allowLink)
    {
        if (!Path.Exists(path))
            CreatePrivate(path);
        var isLink = new DirectoryInfo(path).LinkTarget is not null;
        if ((isLink && !allowLink) || !Directory.Exists(path) || WritableByOthers(path))
            throw new InvalidOperationException($"unsafe scratch/state directory: {path}");
    }

    private static void CreatePrivate(string path)
    {
        try
        {
            if (OperatingSystem.IsWindows())
                Directory.CreateDirectory(path);
            else
                Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        catch (IOException) when (Directory.Exists(path)) { }
    }

    private static bool WritableByOthers(string path) =>
        !OperatingSystem.IsWindows()
        && (File.GetUnixFileMode(path) & (UnixFileMode.GroupWrite | UnixFileMode.OtherWrite)) != UnixFileMode.None;
}

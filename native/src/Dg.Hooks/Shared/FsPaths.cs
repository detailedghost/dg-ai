namespace Dg.Hooks.Shared;

internal readonly record struct Lstat(bool IsLink, bool IsDirectory, double MtimeMs);

internal static class FsPaths
{
    private const int MaxLinkDepth = 40;

    private static readonly EnumerationOptions AllEntries = new()
    {
        AttributesToSkip = 0,
        IgnoreInaccessible = false,
    };

    public static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    public static Lstat? TryLstat(string path)
    {
        var info = new FileInfo(path);
        var attributes = info.Attributes;
        if ((int)attributes == -1)
            return null;
        var link = attributes.HasFlag(FileAttributes.ReparsePoint);
        return new Lstat(
            link,
            !link && attributes.HasFlag(FileAttributes.Directory),
            (info.LastWriteTimeUtc - DateTime.UnixEpoch).TotalMilliseconds
        );
    }

    public static string[] ReadDirOrEmpty(string path)
    {
        try
        {
            var entries = Directory.GetFileSystemEntries(path, "*", AllEntries);
            var names = new string[entries.Length];
            for (var i = 0; i < entries.Length; i++)
                names[i] = Path.GetFileName(entries[i]);
            Array.Sort(names, StringComparer.Ordinal);
            return names;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    public static void DeleteForce(string path)
    {
        if (TryLstat(path) is not { } stat)
            return;
        try
        {
            if (stat.IsLink)
            {
                if (OperatingSystem.IsWindows() && Directory.Exists(path))
                    Directory.Delete(path);
                else
                    File.Delete(path);
            }
            else if (stat.IsDirectory)
                Directory.Delete(path, recursive: true);
            else
                File.Delete(path);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { }
    }

    public static string RealPath(string path, int depth = 0)
    {
        if (depth > MaxLinkDepth)
            throw new IOException($"too many symbolic links: {path}");
        var full = Path.GetFullPath(path);
        var current = Path.GetPathRoot(full)!;
        var parts = full[current.Length..].Split(
            Path.DirectorySeparatorChar,
            StringSplitOptions.RemoveEmptyEntries
        );
        foreach (var part in parts)
        {
            var next = Path.Join(current, part);
            var info = new FileInfo(next);
            current =
                (int)info.Attributes != -1 && info.LinkTarget is not null
                    ? RealPath(info.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? next, depth + 1)
                    : next;
        }
        return current;
    }
}

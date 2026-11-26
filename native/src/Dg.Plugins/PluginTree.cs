namespace Dg.Plugins;

internal static class PluginTree
{
    public static List<string> List(string root)
    {
        var files = new List<string>();
        Walk(root, "", files);
        files.Sort(StringComparer.Ordinal);
        return files;
    }

    public static void Copy(string from, string to, List<string> files, string prefix)
    {
        foreach (var rel in files)
        {
            if (!rel.StartsWith(prefix, StringComparison.Ordinal))
                continue;
            var target = Path.Combine(to, rel[prefix.Length..]);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            var source = Path.Combine(from, rel);
            File.Copy(source, target, overwrite: true);
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(target, IsExecutable(source) ? Mode755 : Mode644);
        }
    }

    public static void Remove(string path)
    {
        if (File.Exists(path))
            File.Delete(path);
        else if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
    }

    private const UnixFileMode Mode644 =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    private const UnixFileMode Mode755 =
        Mode644 | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;

    private const UnixFileMode AnyExecute =
        UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;

    private static bool IsExecutable(string file) =>
        !OperatingSystem.IsWindows() && (File.GetUnixFileMode(file) & AnyExecute) != 0;

    private static void Walk(string dir, string prefix, List<string> files)
    {
        foreach (var entry in new DirectoryInfo(dir).EnumerateFileSystemInfos())
        {
            var rel = prefix.Length == 0 ? entry.Name : $"{prefix}/{entry.Name}";
            if (prefix.Length == 0 && entry.Name == ".git")
                continue;
            if (entry.LinkTarget is not null)
                throw new NotNativeException();
            if (entry is DirectoryInfo)
                Walk(entry.FullName, rel, files);
            else
                files.Add(rel);
        }
    }
}

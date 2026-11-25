namespace Dg.Plugins;

internal sealed class HostSkills(IReadOnlyDictionary<string, string?> env, string homeDir)
{
    private const string Marker = ".dg-plugin";

    private string[] Roots
    {
        get
        {
            var home = Rooted("HOME") ?? homeDir;
            var claude = Rooted("CLAUDE_CONFIG_DIR") ?? Path.Combine(home, ".claude");
            var codex = Rooted("CODEX_HOME") ?? Path.Combine(home, ".codex");
            return [Path.Combine(claude, "skills"), Path.Combine(codex, "skills")];
        }
    }

    private string? Rooted(string key) =>
        env.TryGetValue(key, out var value) && !string.IsNullOrEmpty(value) && Path.IsPathRooted(value) ? value : null;

    public void EnsureRegistrable(string plugin, IEnumerable<string> names)
    {
        foreach (var root in Roots)
            foreach (var name in names)
            {
                var target = Path.Combine(root, name);
                if (new DirectoryInfo(target).LinkTarget is not null)
                    throw new NotNativeException();
                if ((Directory.Exists(target) || File.Exists(target)) && !OwnedBy(target, plugin))
                    throw new NotNativeException();
            }
    }

    public void Register(string plugin, string loaded)
    {
        var names = SkillNames(loaded);
        EnsureRegistrable(plugin, names);
        Unregister(plugin);
        foreach (var root in Roots)
            foreach (var name in names)
            {
                var from = Path.Combine(loaded, name);
                var target = Path.Combine(root, name);
                PluginTree.Copy(from, target, PluginTree.List(from), "");
                var marker = Path.Combine(target, Marker);
                File.WriteAllText(marker, $"{plugin}\n");
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(
                        marker,
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead
                    );
            }
    }

    public void Unregister(string plugin)
    {
        foreach (var root in Roots)
        {
            if (!Directory.Exists(root))
                continue;
            foreach (var name in SkillNames(root))
            {
                var dir = Path.Combine(root, name);
                if (OwnedBy(dir, plugin))
                    PluginTree.Remove(dir);
            }
        }
    }

    private static List<string> SkillNames(string root)
    {
        var names = new List<string>();
        if (!Directory.Exists(root))
            return names;
        foreach (var dir in new DirectoryInfo(root).EnumerateDirectories())
            if (dir.LinkTarget is null)
                names.Add(dir.Name);
        return names;
    }

    private static bool OwnedBy(string dir, string plugin)
    {
        var marker = Path.Combine(dir, Marker);
        return File.Exists(marker) && string.Equals(File.ReadAllText(marker).Trim(), plugin, StringComparison.Ordinal);
    }
}

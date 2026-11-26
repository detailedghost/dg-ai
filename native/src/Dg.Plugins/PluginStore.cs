using System.Text;
using Dg.Core.Config;
using Dg.Core.Paths;
using Dg.Core.Plugins.Runtime;
using PluginNames = Dg.Core.Plugins.Manifest.PluginNames;

namespace Dg.Plugins;

internal sealed class PluginStore(DgPaths paths, DgPathSeams seams)
{
    private const string RecordFile = "dg-plugin.json";

    public string Root => Path.Combine(paths.DataDir, "plugins");

    public string Folder(string name) =>
        PluginNames.IsValid(name) ? Path.Combine(Root, name) : throw new NotNativeException();

    public string Src(string name) => Path.Combine(Folder(name), "src");

    public PluginApprovalRecord? TryRead(string name)
    {
        var file = Path.Combine(Folder(name), RecordFile);
        return File.Exists(file) ? PluginRecordFile.Parse(File.ReadAllBytes(file), name) : null;
    }

    public void Write(PluginApprovalRecord record)
    {
        var file = Path.Combine(Folder(record.Name), RecordFile);
        var temp = $"{file}.{Environment.ProcessId}.{Guid.NewGuid()}.tmp";
        try
        {
            File.WriteAllText(temp, record.ToJson(), new UTF8Encoding(false));
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temp, file, overwrite: true);
        }
        catch
        {
            File.Delete(temp);
            throw;
        }
    }

    public List<string> InstalledNames()
    {
        var names = new List<string>();
        if (!Directory.Exists(Root))
            return names;
        foreach (var dir in new DirectoryInfo(Root).EnumerateDirectories())
            if (dir.LinkTarget is null && PluginNames.IsValid(dir.Name) && File.Exists(Path.Combine(dir.FullName, RecordFile)))
                names.Add(dir.Name);
        names.Sort(StringComparer.Ordinal);
        return names;
    }

    public string TreeHash(string name)
    {
        var src = Src(name);
        PluginTree.List(src);
        return PluginApproval.HashTree(src);
    }

    public static void DeferIfApproved(PluginApprovalRecord record)
    {
        if (record.HasApproval)
            throw new NotNativeException();
    }

    public IReadOnlyDictionary<string, PluginEntry> ConfiguredPlugins()
    {
        if (!File.Exists(paths.ConfigTomlPath))
            throw new NotNativeException();
        var config = DgConfig.Load(seams);
        return config.IsOk ? config.Value!.Plugins : throw new NotNativeException();
    }

    public PluginConfigEdit Config() => new(paths.ConfigTomlPath);

    public HostSkills Hosts() => new(seams.Env, seams.HomeDir);
}

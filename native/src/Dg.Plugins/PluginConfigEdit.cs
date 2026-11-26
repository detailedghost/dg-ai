using Dg.Core.Config;
using Tomlyn.Model;

namespace Dg.Plugins;

internal sealed class PluginConfigEdit(string file)
{
    public void Check(string plugin, bool enabled) => Render(plugin, enabled);

    public void SetEnabled(string plugin, bool enabled) => ConfigFileWriter.Write(file, Render(plugin, enabled));

    private string Render(string plugin, bool enabled)
    {
        if (!File.Exists(file))
            throw new NotNativeException();
        var text = File.ReadAllText(file);
        if (!DgConfig.Parse(text, file).IsOk)
            throw new NotNativeException();
        var raw = RawToml.Parse(text);
        Child(Child(raw, "plugins"), plugin)["enabled"] = enabled;
        var next = TomlWriter.Stringify(raw);
        return DgConfig.Parse(next, file).IsOk ? next : throw new NotNativeException();
    }

    private static TomlTable Child(TomlTable parent, string key)
    {
        if (!parent.TryGetValue(key, out var value))
        {
            var created = new TomlTable();
            parent[key] = created;
            return created;
        }
        return value as TomlTable ?? throw new NotNativeException();
    }
}

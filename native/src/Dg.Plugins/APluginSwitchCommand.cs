using System.Text;
using Dg.Core.Output;

namespace Dg.Plugins;

internal abstract class APluginSwitchCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error,
    bool enable
) : APluginCommand(env, output, error)
{
    protected override int Run(string[] args, PluginStore store, StringBuilder stdout, StringBuilder stderr)
    {
        if (args is not [var name] || name.StartsWith('-'))
            throw new NotNativeException();
        var record = store.TryRead(name);
        if (record is null)
            return Fail(
                stderr,
                $"dg plugin: {name} is not installed. Next: run dg plugin list, or dg plugin add <source>."
            );
        var config = store.Config();
        config.Check(name, enable);
        if (enable)
        {
            if (!store.IsApproved(record))
                return Fail(
                    stderr,
                    $"dg plugin: {name} is not approved, so its text and helper stay untrusted. Next: review it, then run dg plugin verify {name} --approve."
                );
            Load(store, name);
        }
        else
            store.Hosts().Unregister(name);
        config.SetEnabled(name, enable);
        stdout.Append(name).Append(enable ? " enabled\n" : " disabled\n");
        return 0;
    }

    private static void Load(PluginStore store, string name)
    {
        var src = store.Src(name);
        var files = PluginTree.List(src);
        var skills = SkillLayout.Find(files, name);
        var hosts = store.Hosts();
        hosts.EnsureRegistrable(name, skills.Select(static s => s.Name));
        var loaded = store.Loaded(name);
        PluginTree.Remove(loaded);
        foreach (var skill in skills)
            PluginTree.Copy(src, Path.Combine(loaded, skill.Name), files, skill.Prefix);
        hosts.Register(name, loaded);
    }
}

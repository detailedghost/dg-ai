using System.Text;
using Dg.Core.Abstractions;
using Dg.Core.Output;
using Dg.Core.Plugins.Manifest;

namespace Dg.Plugins;

internal sealed class PluginVerifyCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : APluginCommand(env, output, error)
{
    public override string Name => "plugin verify";

    protected override int Run(string[] args, PluginStore store, StringBuilder stdout, StringBuilder stderr)
    {
        var (name, approve) = Parse(args);
        var record = store.TryRead(name);
        if (record is null)
            return Fail(stderr, $"dg plugin: {name} is not installed. Next: run dg plugin list, or dg plugin add <source>.");
        if (!string.Equals(store.TreeHash(name), record.TreeSha256, StringComparison.Ordinal))
            throw new NotNativeException();
        var manifest = ReadManifest(store.Src(name));
        if (approve)
            record = Approve(store, record);
        var approved = record.HasApproval;
        stdout.Append(name).Append(approved ? ": approved\n" : ": unapproved\n");
        var report = manifest is null ? new PermissionReport([], []) : PermissionReport.For(manifest);
        Section(stdout, "dg enforces:", report.Enforced);
        Section(stdout, "dg cannot enforce (declared only):", report.Unenforced);
        if (!approved)
            stdout
                .Append("Imported text stays untrusted until approved. Next: review ")
                .Append(store.Src(name))
                .Append(", then run dg plugin verify ")
                .Append(name)
                .Append(" --approve.\n");
        return 0;
    }

    private static (string Name, bool Approve) Parse(string[] args)
    {
        string? name = null;
        var approve = false;
        foreach (var arg in args)
        {
            if (arg == "--approve" && !approve)
                approve = true;
            else if (arg.StartsWith('-') || name is not null)
                throw new NotNativeException();
            else
                name = arg;
        }
        return name is null ? throw new NotNativeException() : (name, approve);
    }

    private static PluginManifest? ReadManifest(string src)
    {
        var file = Path.Combine(src, "plugin.toml");
        if (!File.Exists(file))
            return null;
        var manifest = ManifestParser.Parse(File.ReadAllText(file), file);
        return manifest.Kind == PluginKind.Skill ? manifest : throw new NotNativeException();
    }

    private static PluginRecord Approve(PluginStore store, PluginRecord record)
    {
        var src = store.Src(record.Name);
        var files = PluginTree.List(src);
        var skills = SkillLayout.Find(files, record.Name);
        var enabled = store.ConfiguredPlugins().TryGetValue(record.Name, out var entry) && entry.Enabled;
        var hosts = store.Hosts();
        if (enabled)
            hosts.EnsureRegistrable(record.Name, skills.Select(static s => s.Name));

        var approved = record with { ApprovedSha256 = record.TreeSha256 };
        store.Write(approved);
        var loaded = store.Loaded(record.Name);
        PluginTree.Remove(loaded);
        foreach (var skill in skills)
            PluginTree.Copy(src, Path.Combine(loaded, skill.Name), files, skill.Prefix);
        if (enabled)
            hosts.Register(record.Name, loaded);
        else
            hosts.Unregister(record.Name);
        return approved;
    }

    private static void Section(StringBuilder sink, string title, IReadOnlyList<string> lines)
    {
        if (lines.Count == 0)
            return;
        sink.Append(title).Append('\n');
        foreach (var line in lines)
            sink.Append("  ").Append(line).Append('\n');
    }
}

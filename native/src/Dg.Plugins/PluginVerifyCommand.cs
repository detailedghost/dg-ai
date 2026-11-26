using System.Text;
using Dg.Core.Abstractions;
using Dg.Core.Output;
using Dg.Core.Plugins.Manifest;

namespace Dg.Plugins;

internal sealed class PluginVerifyCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error,
    Func<bool>? hasTerminal = null
) : APluginCommand(env, output, error)
{
    private readonly Func<bool> _hasTerminal = hasTerminal ?? (static () => !Console.IsInputRedirected);

    public override string Name => "plugin verify";

    protected override int Run(string[] args, PluginStore store, StringBuilder stdout, StringBuilder stderr)
    {
        var (name, approve) = Parse(args);
        if (approve && !_hasTerminal())
        {
            stderr.Append("dg plugin verify --approve needs a person at a terminal; run it yourself.\n");
            return 1;
        }
        var record = store.TryRead(name);
        if (record is null)
            return Fail(
                stderr,
                $"dg plugin: {name} is not installed. Next: run dg plugin list, or dg plugin add <source>."
            );
        if (!string.Equals(store.TreeHash(name), record.TreeSha256, StringComparison.Ordinal))
            throw new NotNativeException();
        var manifest = ReadManifest(store.Src(name));
        if (approve)
            throw new NotNativeException();
        PluginStore.AssertUnapproved(record);
        stdout.Append(name).Append(": unapproved\n");
        var report = manifest is null ? new PermissionReport([], []) : PermissionReport.For(manifest);
        Section(stdout, "dg enforces:", report.Enforced);
        Section(stdout, "dg cannot enforce (declared only):", report.Unenforced);
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

    private static void Section(StringBuilder sink, string title, IReadOnlyList<string> lines)
    {
        if (lines.Count == 0)
            return;
        sink.Append(title).Append('\n');
        foreach (var line in lines)
            sink.Append("  ").Append(line).Append('\n');
    }
}

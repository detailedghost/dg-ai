using System.Text;
using Dg.Core.Output;

namespace Dg.Plugins;

internal sealed class PluginListCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : APluginCommand(env, output, error)
{
    public override string Name => "plugin list";

    protected override int Run(string[] args, PluginStore store, StringBuilder stdout, StringBuilder stderr)
    {
        var json = args is ["--json"];
        if (args.Length != 0 && !json)
            throw new NotNativeException();
        var names = store.InstalledNames();
        if (names.Count == 0)
        {
            stdout.Append(json ? "[]\n" : "no plugins installed. Next: run dg plugin add <git url or path>.\n");
            return 0;
        }
        var configured = store.ConfiguredPlugins();
        if (json)
            stdout.Append("[\n");
        for (var i = 0; i < names.Count; i++)
        {
            var record = store.TryRead(names[i]) ?? throw new NotNativeException();
            var enabled = configured.TryGetValue(names[i], out var entry) && entry.Enabled;
            PluginStore.AssertUnapproved(record);
            if (json)
                AppendJson(stdout, names[i], record, enabled, last: i == names.Count - 1);
            else
                stdout
                    .Append(names[i])
                    .Append('\t')
                    .Append(record.Kind)
                    .Append('\t')
                    .Append(enabled ? "on" : "off")
                    .Append('\t')
                    .Append("unapproved")
                    .Append('\t')
                    .Append(record.Pin)
                    .Append('\n');
        }
        if (json)
            stdout.Append("]\n");
        return 0;
    }

    private static void AppendJson(
        StringBuilder sink,
        string name,
        PluginRecord record,
        bool enabled,
        bool last
    )
    {
        sink.Append("  {\n    \"name\": ");
        JsonText.Quote(sink, name);
        sink.Append(",\n    \"kind\": ");
        JsonText.Quote(sink, record.Kind);
        sink.Append(",\n    \"pin\": {\n      \"kind\": ");
        JsonText.Quote(sink, record.PinKind);
        sink.Append(",\n      \"value\": ");
        JsonText.Quote(sink, record.PinValue);
        sink.Append("\n    },\n    \"enabled\": ").Append(enabled ? "true" : "false");
        sink.Append(",\n    \"approved\": false");
        sink.Append(",\n    \"source\": ");
        JsonText.Quote(sink, record.Source);
        sink.Append(last ? "\n  }\n" : "\n  },\n");
    }
}

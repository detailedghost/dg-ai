using System.Text;
using Dg.Core.Config;

namespace Dg.Core.Tests.Config;

internal static class DgTomlJson
{
    public static string Write(DgToml toml)
    {
        var builder = new StringBuilder("{");
        builder.Append("\"browser\":{\"mode\":").Append(TomlJson.Stringify(toml.BrowserMode.Wire())).Append("},");
        builder.Append("\"front\":{\"enabled\":").Append(TomlJson.Stringify(toml.FrontEnabled)).Append("},");
        builder.Append("\"hooks\":{");
        Join(builder, toml.Hooks, (b, hook) => Strings(b, hook));
        builder.Append("},\"install\":{\"cli_only\":").Append(TomlJson.Stringify(toml.InstallCliOnly)).Append("},");
        builder.Append("\"refs\":{");
        if (toml.RefsDefaultRepo is { } repo)
            builder.Append("\"default_repo\":").Append(TomlJson.Stringify(repo)).Append(',');
        builder.Append("\"aliases\":{");
        Join(builder, toml.RefsAliases, (b, alias) => b.Append(TomlJson.Stringify(alias)));
        builder.Append("}},\"inbox\":").Append(TomlJson.Stringify(toml.Inbox));
        builder.Append(",\"ssms\":").Append(TomlJson.Stringify(toml.Ssms));
        builder.Append(",\"plugins\":{");
        Join(builder, toml.Plugins, Plugin);
        builder.Append("},\"meta\":{\"migrated\":{");
        Join(builder, toml.MetaMigrated, (b, value) => b.Append(TomlJson.Stringify(value)));
        builder.Append("}}}");
        return builder.ToString();
    }

    private static void Strings(StringBuilder builder, IReadOnlyDictionary<string, string> values)
    {
        builder.Append('{');
        Join(builder, values, (b, value) => b.Append(TomlJson.Stringify(value)));
        builder.Append('}');
    }

    private static void Plugin(StringBuilder builder, PluginEntry plugin)
    {
        builder.Append("{\"enabled\":").Append(TomlJson.Stringify(plugin.Enabled));
        builder.Append(",\"allow_remote\":").Append(TomlJson.Stringify(plugin.AllowRemote));
        if (plugin.Source is { } source)
            builder.Append(",\"source\":").Append(TomlJson.Stringify(source));
        builder.Append(",\"settings\":").Append(TomlJson.Stringify(plugin.Settings)).Append('}');
    }

    private static void Join<T>(
        StringBuilder builder,
        IReadOnlyDictionary<string, T> values,
        Action<StringBuilder, T> write
    )
    {
        var first = true;
        foreach (var (name, value) in values)
        {
            if (!first)
                builder.Append(',');
            first = false;
            builder.Append(TomlJson.Stringify(name)).Append(':');
            write(builder, value);
        }
    }
}

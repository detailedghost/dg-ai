using Dg.Core.Config;
using Dg.Core.Credentials;
using Tomlyn.Model;

namespace Dg.Config;

internal static class ConfigValues
{
    public static string Shown(object? value) =>
        value switch
        {
            null => "",
            string text => text,
            _ when SecretRef.TryRead(value, out var reference) => $"{{ credential = \"{reference.Credential}\" }}",
            TomlTable table => TomlWriter.Stringify(table).TrimEnd(),
            bool flag => flag ? "true" : "false",
            _ => TomlJson.Stringify(value),
        };
}

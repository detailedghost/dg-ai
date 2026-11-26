using Tomlyn;
using Tomlyn.Model;
using Tomlyn.Serialization;

namespace Dg.Core.Config;

[TomlSerializable(typeof(TomlTable))]
internal sealed partial class RawTomlContext : TomlSerializerContext;

public static class RawToml
{
    public static TomlTable Parse(string text) =>
        TomlSerializer.Deserialize(text, RawTomlContext.Default.TomlTable) ?? new TomlTable();

    public static object ParseValue(string raw)
    {
        try
        {
            return Parse($"v = {raw}").TryGetValue("v", out var value) && value is not null ? value : raw;
        }
        catch (TomlException)
        {
            return raw;
        }
    }
}

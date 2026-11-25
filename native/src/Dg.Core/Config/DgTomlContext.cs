using Tomlyn.Model;
using Tomlyn.Serialization;

namespace Dg.Core.Config;

[TomlSerializable(typeof(TomlTable))]
internal sealed partial class DgTomlContext : TomlSerializerContext;

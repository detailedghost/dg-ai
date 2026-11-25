using Tomlyn.Model;
using Tomlyn.Serialization;

namespace Dg.Core.Plugins.Manifest;

[TomlSerializable(typeof(TomlTable))]
internal sealed partial class ManifestTomlContext : TomlSerializerContext;

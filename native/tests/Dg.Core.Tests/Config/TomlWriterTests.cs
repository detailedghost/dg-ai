using Dg.Core.Config;
using Tomlyn.Model;

namespace Dg.Core.Tests.Config;

public sealed class TomlWriterTests
{
    [Fact]
    public void Stringify_NestedPluginTable_WritesHeaderAndKey()
    {
        var document = new TomlTable { ["plugins"] = new TomlTable { ["alpha"] = new TomlTable { ["enabled"] = true } } };

        Assert.Equal("[plugins.alpha]\nenabled = true\n", TomlWriter.Stringify(document));
    }

    [Fact]
    public void Stringify_RoundTripsThroughRawToml()
    {
        const string text = "[front]\nenabled = false\n\n[plugins.\"q x\"]\nenabled = true\n";

        Assert.Equal(text, TomlWriter.Stringify(RawToml.Parse(text)));
    }
}

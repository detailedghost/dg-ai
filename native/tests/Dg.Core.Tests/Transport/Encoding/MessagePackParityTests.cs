using System.Text.Json;
using Dg.Core.Plugins.Contract;
using Dg.Core.Tests.Plugins;
using Dg.Core.Transport.Codec;

namespace Dg.Core.Tests.Transport.Codec;

public sealed class MessagePackParityTests
{
    public static TheoryData<string> ValidFiles()
    {
        var data = new TheoryData<string>();
        foreach (var file in PluginFixtures.Files("messages/valid", "*.json"))
            data.Add(file);
        return data;
    }

    [Theory]
    [MemberData(nameof(ValidFiles))]
    public void RoundTrip_ValidFixtureBody_JsonMessagePackJsonUnchanged(string file)
    {
        using var doc = PluginFixtures.ReadJson("messages", "valid", file);
        var json = JsonSerializer.SerializeToUtf8Bytes(doc.RootElement.GetProperty("body"), PluginJsonContext.Default.JsonElement);

        var packed = MessagePackTranscoder.FromJson(json);
        var back = MessagePackTranscoder.ToJson(packed);

        Assert.Equal(json, back);
    }

    [Theory]
    [MemberData(nameof(ValidFiles))]
    public void RoundTrip_ValidFixtureEnvelope_JsonMessagePackJsonUnchanged(string file)
    {
        using var doc = PluginFixtures.ReadJson("messages", "valid", file);
        var envelope = new PluginEnvelope(
            doc.RootElement.GetProperty("route").GetString()!,
            doc.RootElement.GetProperty("body").Clone()
        );
        var json = JsonSerializer.SerializeToUtf8Bytes(envelope, PluginJsonContext.Default.PluginEnvelope);

        var back = MessagePackTranscoder.ToJson(MessagePackTranscoder.FromJson(json));

        Assert.Equal(json, back);
    }

    [Fact]
    public void FromJson_Hello_ProducesMessagePackMap()
    {
        var packed = MessagePackTranscoder.FromJson("""{"a":1}"""u8);

        Assert.Equal(new byte[] { 0x81, 0xa1, (byte)'a', 0x01 }, packed);
    }

    [Fact]
    public void RoundTrip_ScalarsAndNesting_Unchanged()
    {
        var json = """{"n":null,"t":true,"f":false,"i":-5,"big":18446744073709551615,"d":1.5,"s":"héllo","a":[1,[2],{}],"o":{"k":[]}}"""u8;

        var back = MessagePackTranscoder.ToJson(MessagePackTranscoder.FromJson(json));

        using var expected = JsonDocument.Parse(json.ToArray());
        using var actual = JsonDocument.Parse(back);
        Assert.Equal(
            JsonSerializer.Serialize(expected.RootElement, PluginJsonContext.Default.JsonElement),
            JsonSerializer.Serialize(actual.RootElement, PluginJsonContext.Default.JsonElement)
        );
    }

    [Fact]
    public void ToJson_TrailingBytes_Throws()
    {
        var ex = Assert.Throws<PluginContractException>(() => MessagePackTranscoder.ToJson(new byte[] { 0x80, 0x00 }));

        Assert.Equal("bad-payload", ex.Code);
    }

    [Fact]
    public void ToJson_NonStringKey_Throws()
    {
        var ex = Assert.Throws<PluginContractException>(() => MessagePackTranscoder.ToJson(new byte[] { 0x81, 0x01, 0x01 }));

        Assert.Equal("bad-payload", ex.Code);
    }

    [Fact]
    public void ToJson_Truncated_Throws()
    {
        var ex = Assert.Throws<PluginContractException>(() => MessagePackTranscoder.ToJson(new byte[] { 0x81, 0xa1 }));

        Assert.Equal("bad-payload", ex.Code);
    }
}

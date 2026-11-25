using System.Text.Json;
using Dg.Core.Plugins.Contract;
using Dg.Core.Tests.Plugins;
using Dg.Core.Transport.Codec;

namespace Dg.Core.Tests.Transport.Encoding;

public sealed class EncodingNegotiatorTests
{
    [Theory]
    [InlineData("json,msgpack", "json,msgpack", FrameEncoding.MessagePack)]
    [InlineData("json,msgpack", "json", FrameEncoding.Json)]
    [InlineData("json", "json,msgpack", FrameEncoding.Json)]
    [InlineData("json", "json", FrameEncoding.Json)]
    [InlineData("msgpack", "msgpack", FrameEncoding.MessagePack)]
    [InlineData("", "", FrameEncoding.Json)]
    [InlineData("json,bogus", "bogus,json", FrameEncoding.Json)]
    public void Choose_Offers_MessagePackOnlyWhenBothOffer(string client, string plugin, FrameEncoding expected)
    {
        var actual = EncodingNegotiator.Choose(Split(client), Split(plugin));

        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData(FrameEncoding.Json, "json")]
    [InlineData(FrameEncoding.MessagePack, "msgpack")]
    public void Name_Encoding_ReturnsHelloToken(FrameEncoding encoding, string expected) =>
        Assert.Equal(expected, EncodingNegotiator.Name(encoding));

    [Fact]
    public void Choose_HelloFixtureOffers_AgreesOnFixtureResponseEncoding()
    {
        using var request = PluginFixtures.ReadJson("messages", "valid", "hello-request.json");
        using var response = PluginFixtures.ReadJson("messages", "valid", "hello-response.json");
        var offers = request
            .RootElement.GetProperty("body")
            .Deserialize(PluginJsonContext.Default.HelloRequest)!
            .Encodings;

        var chosen = EncodingNegotiator.Choose(offers, ["json", "msgpack"]);

        Assert.Equal(
            response.RootElement.GetProperty("body").GetProperty("encoding").GetString(),
            EncodingNegotiator.Name(chosen)
        );
    }

    private static string[] Split(string value) => value.Length == 0 ? [] : value.Split(',');
}

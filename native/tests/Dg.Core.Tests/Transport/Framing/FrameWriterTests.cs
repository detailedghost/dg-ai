using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;

namespace Dg.Core.Tests.Transport.Framing;

public sealed class FrameWriterTests
{
    public static TheoryData<string> Names() => FrameFixtures.ValidNames();

    [Theory]
    [MemberData(nameof(Names))]
    public void Encode_FixtureFrame_MatchesWireBytes(string name)
    {
        var fixture = FrameFixtures.Valid().Single(f => f.Name == name);

        using var frame = FrameWriter.Encode((FrameEncoding)fixture.Encoding, (FrameFlags)fixture.Flags, fixture.RequestId, fixture.Payload);

        Assert.Equal(fixture.Wire, frame.Memory.ToArray());
    }

    [Fact]
    public void Encode_OversizePayload_Throws()
    {
        var ex = Assert.Throws<PluginContractException>(() =>
            FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, 1, new byte[PluginProtocol.MaxPayloadBytes + 1])
        );

        Assert.Equal("oversize", ex.Code);
    }
}

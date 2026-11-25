using System.Text;
using System.Text.Json;
using Dg.Core.Plugins.Contract;

namespace Dg.Core.Tests.Plugins;

public sealed class FrameCodecTests
{
    private static readonly string[] InvalidMessages =
    [
        "short-header\tdg plugin: frame short-header: got 5 bytes, a header is 12. Next: read 12 bytes before you decode",
        "bad-version\tdg plugin: frame bad-version: version 2, this dg speaks 1. Next: update the plugin to protocol 1",
        "bad-encoding\tdg plugin: frame bad-encoding: encoding 2 is not 0 (json) or 1 (msgpack). Next: negotiate the encoding in hello",
        "reserved-flags\tdg plugin: frame reserved-flags: flags 0x8 set a reserved bit. Next: send zero in every reserved flag bit",
        "oversize\tdg plugin: frame oversize: length 1048577, the limit is 1048576. Next: close the connection and send smaller payloads",
        "truncated-payload\tdg plugin: frame truncated-payload: header says 5 payload bytes, got 2. Next: read the full payload",
        "trailing-bytes\tdg plugin: frame trailing-bytes: 3 bytes follow the payload. Next: split the stream at each header length",
    ];

    public static TheoryData<string> ValidNames()
    {
        using var doc = PluginFixtures.ReadJson("frames", "frames.json");
        var data = new TheoryData<string>();
        foreach (var entry in doc.RootElement.GetProperty("valid").EnumerateArray())
            data.Add(entry.GetProperty("name").GetString()!);
        return data;
    }

    public static TheoryData<string> InvalidNames()
    {
        using var doc = PluginFixtures.ReadJson("frames", "frames.json");
        var data = new TheoryData<string>();
        foreach (var entry in doc.RootElement.GetProperty("invalid").EnumerateArray())
            data.Add(entry.GetProperty("name").GetString()!);
        return data;
    }

    private static JsonElement Entry(string section, string name)
    {
        using var doc = PluginFixtures.ReadJson("frames", "frames.json");
        foreach (var entry in doc.RootElement.GetProperty(section).EnumerateArray())
            if (entry.GetProperty("name").GetString() == name)
                return entry.Clone();
        throw new KeyNotFoundException(name);
    }

    private static byte[] Payload(JsonElement entry) =>
        entry.TryGetProperty("payloadText", out var text)
            ? Encoding.UTF8.GetBytes(text.GetString()!)
            : Convert.FromHexString(entry.GetProperty("payloadHex").GetString()!);

    [Theory]
    [MemberData(nameof(ValidNames))]
    public void Decode_ValidFixture_ReturnsFixtureFields(string name)
    {
        var entry = Entry("valid", name);

        var frame = FrameCodec.Decode(Convert.FromHexString(entry.GetProperty("hex").GetString()!));

        Assert.Equal((byte)entry.GetProperty("version").GetInt32(), frame.Header.Version);
        Assert.Equal((byte)entry.GetProperty("encoding").GetInt32(), (byte)frame.Header.Encoding);
        Assert.Equal((ushort)entry.GetProperty("flags").GetInt32(), (ushort)frame.Header.Flags);
        Assert.Equal(entry.GetProperty("requestId").GetUInt32(), frame.Header.RequestId);
        Assert.Equal(Payload(entry), frame.Payload.ToArray());
    }

    [Theory]
    [MemberData(nameof(ValidNames))]
    public void Encode_ValidFixture_ProducesFixtureBytes(string name)
    {
        var entry = Entry("valid", name);

        var bytes = FrameCodec.Encode(
            (FrameEncoding)entry.GetProperty("encoding").GetInt32(),
            (FrameFlags)entry.GetProperty("flags").GetInt32(),
            entry.GetProperty("requestId").GetUInt32(),
            Payload(entry)
        );

        Assert.Equal(entry.GetProperty("hex").GetString(), Convert.ToHexStringLower(bytes));
    }

    [Theory]
    [MemberData(nameof(InvalidNames))]
    public void Decode_InvalidFixture_ThrowsFixtureCodeWithExactText(string name)
    {
        var entry = Entry("invalid", name);
        var expected = InvalidMessages.Single(line => line.StartsWith(name + "\t", StringComparison.Ordinal)).Split('\t')[1];

        var error = Assert.Throws<PluginContractException>(() =>
            FrameCodec.Decode(Convert.FromHexString(entry.GetProperty("hex").GetString()!))
        );

        Assert.Equal(entry.GetProperty("error").GetString(), error.Code);
        Assert.Equal(expected, error.Message);
    }

    [Fact]
    public void Parse_BigEndianHeaderSpan_ReadsEveryField()
    {
        ReadOnlySpan<byte> bytes = [1, 1, 0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x01, 0x00];

        var header = FrameHeader.Parse(bytes);

        Assert.Equal(new FrameHeader(1, FrameEncoding.MessagePack, FrameFlags.Response | FrameFlags.Event, 0x01020304u, 256u), header);
    }

    [Fact]
    public void Write_Header_RoundTripsThroughParse()
    {
        var header = new FrameHeader(1, FrameEncoding.Json, FrameFlags.Error | FrameFlags.Response, 4_294_967_295u, 9u);
        Span<byte> buffer = stackalloc byte[PluginProtocol.HeaderBytes];

        header.Write(buffer);

        Assert.Equal(header, FrameHeader.Parse(buffer));
        Assert.Equal("01000003ffffffff00000009", Convert.ToHexStringLower(buffer));
    }

    [Fact]
    public void Encode_PayloadOverLimit_ThrowsOversize()
    {
        var payload = new byte[PluginProtocol.MaxPayloadBytes + 1];

        var error = Assert.Throws<PluginContractException>(() => FrameCodec.Encode(FrameEncoding.Json, FrameFlags.None, 1, payload));

        Assert.Equal("oversize", error.Code);
        Assert.Equal(
            "dg plugin: frame oversize: payload is 1048577 bytes, the limit is 1048576. Next: send a smaller payload",
            error.Message
        );
    }

    [Fact]
    public void Limits_MatchProtocolDocument()
    {
        Assert.Equal(1, PluginProtocol.Version);
        Assert.Equal(12, PluginProtocol.HeaderBytes);
        Assert.Equal(1_048_576, PluginProtocol.MaxPayloadBytes);
        Assert.Equal(1_200, PluginProtocol.UdpMaxFrameBytes);
    }
}

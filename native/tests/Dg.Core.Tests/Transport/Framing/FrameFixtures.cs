using System.Text;
using System.Text.Json;
using Dg.Core.Tests.Plugins;

namespace Dg.Core.Tests.Transport.Framing;

internal sealed record FrameFixture(string Name, byte Encoding, ushort Flags, uint RequestId, byte[] Payload, byte[] Wire);

internal static class FrameFixtures
{
    public static IReadOnlyList<FrameFixture> Valid()
    {
        using var doc = PluginFixtures.ReadJson("frames", "frames.json");
        var list = new List<FrameFixture>();
        foreach (var e in doc.RootElement.GetProperty("valid").EnumerateArray())
        {
            var payload = e.TryGetProperty("payloadText", out var text)
                ? Encoding.UTF8.GetBytes(text.GetString()!)
                : Convert.FromHexString(e.GetProperty("payloadHex").GetString()!);
            list.Add(
                new(
                    e.GetProperty("name").GetString()!,
                    e.GetProperty("encoding").GetByte(),
                    e.GetProperty("flags").GetUInt16(),
                    e.GetProperty("requestId").GetUInt32(),
                    payload,
                    Convert.FromHexString(e.GetProperty("hex").GetString()!)
                )
            );
        }
        return list;
    }

    public static IReadOnlyList<(string Name, string Error, byte[] Wire)> Invalid()
    {
        using var doc = PluginFixtures.ReadJson("frames", "frames.json");
        return
        [
            .. doc.RootElement.GetProperty("invalid")
                .EnumerateArray()
                .Select(e => (
                    e.GetProperty("name").GetString()!,
                    e.GetProperty("error").GetString()!,
                    Convert.FromHexString(e.GetProperty("hex").GetString()!)
                )),
        ];
    }

    public static TheoryData<string> ValidNames()
    {
        var data = new TheoryData<string>();
        foreach (var f in Valid())
            data.Add(f.Name);
        return data;
    }
}

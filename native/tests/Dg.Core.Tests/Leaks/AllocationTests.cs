using System.Text;
using System.Text.Json;
using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Http;
using Dg.Core.Transport.Udp;

namespace Dg.Core.Tests.Leaks;

[Collection(LeakCollection.Name)]
public sealed class AllocationTests
{
    private static readonly byte[] Payload = Encoding.UTF8.GetBytes("""{"route":"/v1/hook/decide","body":{"event":"pre-tool-use","tool":"Bash"}}""");

    private sealed class Tokens : IPluginTokenProvider
    {
        public ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct) => new("tok");
    }

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;

    [Fact]
    public void FrameCodecDecode_ValidFrame_AllocatesNothing()
    {
        var frame = FrameCodec.Encode(FrameEncoding.Json, FrameFlags.None, 7, Payload);

        Assert.Equal(0, LeakMeter.AllocatedPerIteration(() => FrameCodec.Decode(frame)));
    }

    [Fact]
    public void FrameWriterEncode_PooledFrame_AllocatesNothing()
    {
        Assert.Equal(
            0,
            LeakMeter.AllocatedPerIteration(() =>
            {
                using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, 7, Payload);
            })
        );
    }

    [Theory]
    [InlineData(PluginRoutes.HookDecide, MessageDirection.Request, """{"event":"pre-tool-use","tool":"Bash","input":{"a":1}}""")]
    [InlineData(PluginRoutes.HookDecide, MessageDirection.Response, """{"decision":"allow","reason":"ok"}""")]
    [InlineData(PluginRoutes.Hello, MessageDirection.Request, """{"protocol":1,"encodings":["json","msgpack"],"capabilities":["a","b"],"token":"t"}""")]
    [InlineData(PluginRoutes.Hello, MessageDirection.Response, """{"protocol":1,"encoding":"json","capabilities":["a","b"]}""")]
    public void Validate_ValidMessage_AllocatesNothing(string route, MessageDirection direction, string body)
    {
        var element = Json(body);

        Assert.Equal(0, LeakMeter.AllocatedPerIteration(() => MessageValidator.Validate(route, direction, element)));
    }

    [Fact]
    public void UdpEncode_SmallEvent_AllocatesOnlyTheFrame()
    {
        var ev = new PluginEvent("/v1/job/status", Encoding.UTF8.GetBytes("{\"a\":1}"));
        var frame = UdpTransport.Encode(ev)!;

        var bytes = LeakMeter.AllocatedPerIteration(() => UdpTransport.Encode(ev));

        Assert.True(bytes <= frame.Length + 32, $"encode allocates {bytes} bytes for a {frame.Length} byte frame");
    }

    [Fact]
    public async Task OpenAsync_ExistingEndpoint_AllocatesNothing()
    {
        var manifest = new PluginManifest(
            "scanner",
            "1.0.0",
            PluginKind.Hook,
            PluginTransportKind.Http,
            "http://127.0.0.1:1",
            false,
            null,
            null,
            new(null, "scanner", []),
            new(false, [], [], []),
            new([], [])
        );
        await using var provider = new HttpTransportProvider(new HttpTransportFactory(new Tokens()));
        await (await provider.OpenAsync(manifest, false, CancellationToken.None)).DisposeAsync();

        var bytes = LeakMeter.AllocatedPerIteration(() =>
        {
            var lease = provider.OpenAsync(manifest, false, CancellationToken.None).GetAwaiter().GetResult();
            lease.DisposeAsync().GetAwaiter().GetResult();
        });

        Assert.Equal(0, bytes);
    }
}

using System.Text;
using System.Text.Json;
using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Http;
using Dg.Core.Transport.Udp;

namespace Dg.Core.Tests.Leaks;

[Collection(LeakCollection.Name)]
public sealed class AllocationTests
{
    private static readonly byte[] Payload = Encoding.UTF8.GetBytes("""{"route":"/v1/hook/decide","body":{"event":"pre-tool-use","tool":"Bash"}}""");

    private const int MaxLeaseBytes = 48;

    private sealed class Tokens : IPluginTokenProvider
    {
        public ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct) => new("tok");
    }

    [Fact]
    public void FrameCodecDecode_ValidFrame_AllocatesNothing()
    {
        var frame = FrameCodec.Encode(FrameEncoding.Json, FrameFlags.None, 7, Payload);

        Assert.Equal(0d, AllocationProbe.BytesPerOp(() => FrameCodec.Decode(frame)));
    }

    [Fact]
    public void FrameWriterEncode_PooledFrame_AllocatesNothing()
    {
        Assert.Equal(
            0d,
            AllocationProbe.BytesPerOp(() =>
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
        using var document = JsonDocument.Parse(body);
        var element = document.RootElement;

        Assert.Equal(0d, AllocationProbe.BytesPerOp(() => MessageValidator.Validate(route, direction, element)));
    }

    [Fact]
    public void UdpEncode_SmallEvent_AllocatesOnlyTheFrame()
    {
        var ev = new PluginEvent("/v1/job/status", Encoding.UTF8.GetBytes("{\"a\":1}"));
        var frame = UdpTransport.Encode(ev)!;

        var bytes = AllocationProbe.BytesPerOp(() => UdpTransport.Encode(ev));

        Assert.True(bytes <= frame.Length + 32, $"encode allocates {bytes} bytes for a {frame.Length} byte frame");
    }

    [Fact]
    public async Task OpenAsync_ExistingEndpoint_AllocatesOnlyTheLease()
    {
        var manifest = TestManifest.Http("http://127.0.0.1:1");
        await using var provider = new HttpTransportProvider(new HttpTransportFactory(new Tokens()));
        await (await provider.OpenAsync(manifest, false, CancellationToken.None)).DisposeAsync();

        var bytes = AllocationProbe.BytesPerOp(() =>
        {
            var lease = provider.OpenAsync(manifest, false, CancellationToken.None).GetAwaiter().GetResult();
            lease.DisposeAsync().GetAwaiter().GetResult();
        });

        Assert.True(bytes <= MaxLeaseBytes, $"open and release allocated {bytes} B/op");
    }

    [Fact]
    public void UdpEncode_ManyThreads_EveryFrameMatchesItsEvent()
    {
        var failures = new System.Collections.Concurrent.ConcurrentBag<string>();

        Parallel.For(
            0,
            16,
            worker =>
            {
                for (var i = 0; i < 2_000; i++)
                {
                    var body = $"{{\"w\":{worker},\"i\":{i}}}";
                    var frame = UdpTransport.Encode(new PluginEvent("/v1/job/status", Encoding.UTF8.GetBytes(body)));
                    var text = frame is null ? null : Encoding.UTF8.GetString(FrameCodec.Decode(frame).Payload.Span);
                    if (text != $"{{\"route\":\"/v1/job/status\",\"body\":{body}}}")
                        failures.Add(text ?? "null");
                }
            }
        );

        Assert.Empty(failures);
    }

    [Fact]
    public void UdpEncode_AfterOversizeBody_StillEncodesSmallEvents()
    {
        var huge = new PluginEvent("/v1/job/status", Encoding.UTF8.GetBytes("{\"x\":\"" + new string('a', 200_000) + "\"}"));
        var small = new PluginEvent("/v1/job/status", Encoding.UTF8.GetBytes("{\"a\":1}"));

        Assert.Null(UdpTransport.Encode(huge));

        Assert.NotNull(UdpTransport.Encode(small));
    }
}

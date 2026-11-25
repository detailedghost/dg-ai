using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Udp;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Tests.Transport.Udp;

public sealed class UdpTransportTests
{
    private static PluginEvent Event(string route = "/v1/job/status", string body = "{\"a\":1}") =>
        new(route, Encoding.UTF8.GetBytes(body));

    private static PluginManifest Manifest(
        PluginKind kind = PluginKind.Job,
        string? endpoint = "127.0.0.1:9000",
        bool remote = false,
        PluginTransportKind transport = PluginTransportKind.Udp
    ) =>
        new(
            "metrics",
            "1.0.0",
            kind,
            transport,
            endpoint,
            remote,
            null,
            null,
            new(null, "metrics", []),
            new(false, [], [], []),
            new([], [])
        );

    private static UdpClient Listen(out IPEndPoint endpoint)
    {
        var listener = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        endpoint = (IPEndPoint)listener.Client.LocalEndPoint!;
        return listener;
    }

    [Fact]
    public async Task Post_Event_SendsFrameWithEventFlagAndEnvelope()
    {
        using var listener = Listen(out var endpoint);
        await using var transport = new UdpTransport(endpoint);

        transport.Post(Event());

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var received = await listener.ReceiveAsync(cts.Token);
        var frame = FrameCodec.Decode(received.Buffer);
        Assert.Equal(FrameFlags.Event, frame.Header.Flags);
        Assert.Equal(FrameEncoding.Json, frame.Header.Encoding);
        Assert.Equal("{\"route\":\"/v1/job/status\",\"body\":{\"a\":1}}", Encoding.UTF8.GetString(frame.Payload.Span));
        Assert.True(received.Buffer.Length <= PluginProtocol.UdpMaxFrameBytes);
    }

    [Fact]
    public async Task Post_OversizeEvent_DropsAndCounts()
    {
        using var listener = Listen(out var endpoint);
        await using var transport = new UdpTransport(endpoint);
        var big = "{\"x\":\"" + new string('a', 1_300) + "\"}";

        transport.Post(Event(body: big));

        Assert.Equal(1, transport.Dropped);
        Assert.Equal(0, transport.Sent);
    }

    [Fact]
    public async Task Post_InvalidJsonBody_DropsAndCounts()
    {
        using var listener = Listen(out var endpoint);
        await using var transport = new UdpTransport(endpoint);

        transport.Post(Event(body: "{nope"));

        Assert.Equal(1, transport.Dropped);
    }

    [Fact]
    public async Task Post_TenThousandEvents_DoesNotWaitOnTheNetwork()
    {
        using var listener = Listen(out var endpoint);
        await using var transport = new UdpTransport(endpoint, capacity: 64);
        var ev = Event();
        transport.Post(ev);

        var watch = Stopwatch.StartNew();
        for (var i = 0; i < 10_000; i++)
            transport.Post(ev);
        watch.Stop();

        Assert.True(watch.ElapsedMilliseconds < 1_000, $"10k posts took {watch.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task Post_FullBatch_DropsInsteadOfBlocking()
    {
        using var listener = Listen(out var endpoint);
        await using var transport = new UdpTransport(endpoint, capacity: 4);
        var ev = Event();

        for (var i = 0; i < 10_000; i++)
            transport.Post(ev);

        Assert.True(transport.Dropped > 0);
    }

    [Fact]
    public void Constructor_NonLoopbackEndpoint_Throws()
    {
        var error = Assert.Throws<PluginContractException>(() =>
            new UdpTransport(new IPEndPoint(IPAddress.Parse("192.0.2.1"), 9000))
        );
        Assert.Equal("udp-refused", error.Code);
    }

    [Fact]
    public void Resolve_HookOverUdp_IsRefused()
    {
        var error = Assert.Throws<PluginContractException>(() => UdpEventGuard.Resolve(Manifest(PluginKind.Hook)));
        Assert.Equal("udp-refused", error.Code);
        Assert.Contains("hook", error.Message);
    }

    [Fact]
    public void Resolve_JobOverLoopback_ReturnsEndpoint()
    {
        var endpoint = UdpEventGuard.Resolve(Manifest());
        Assert.Equal(new IPEndPoint(IPAddress.Loopback, 9000), endpoint);
    }

    [Theory]
    [InlineData("203.0.113.5:9000")]
    [InlineData("localhost")]
    [InlineData(null)]
    public void Resolve_BadEndpoint_IsRefused(string? endpoint)
    {
        var error = Assert.Throws<PluginContractException>(() => UdpEventGuard.Resolve(Manifest(endpoint: endpoint)));
        Assert.Equal("udp-refused", error.Code);
    }

    [Fact]
    public void Resolve_RemoteOrOtherTransport_IsRefused()
    {
        Assert.Throws<PluginContractException>(() => UdpEventGuard.Resolve(Manifest(remote: true)));
        Assert.Throws<PluginContractException>(() =>
            UdpEventGuard.Resolve(Manifest(transport: PluginTransportKind.Tcp))
        );
    }

    [Fact]
    public async Task AddUdpTransport_RegistersFactoryThatRefusesHooks()
    {
        var provider = new ServiceCollection().AddUdpTransport().BuildServiceProvider();
        var factory = provider.GetRequiredService<UdpSinkFactory>();

        Assert.Throws<PluginContractException>(() => factory(Manifest(PluginKind.Hook)));
        using var listener = Listen(out var endpoint);
        var sink = factory(Manifest(endpoint: endpoint.ToString()));
        sink.Post(Event());
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await listener.ReceiveAsync(cts.Token);
        await ((IAsyncDisposable)sink).DisposeAsync();
    }
}

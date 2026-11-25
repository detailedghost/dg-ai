using System.Diagnostics;
using System.Text;
using Dg.Core.Errors;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Ipc;
using Dg.Core.Transport.Pool;
using Microsoft.Extensions.DependencyInjection;
using Xunit.Sdk;

namespace Dg.Core.Tests.Transport.Ipc;

public sealed class IpcTransportTests
{
    private static readonly byte[] HookMessage = Encoding.UTF8.GetBytes(
        """{"route":"/v1/hook/decide","body":{"event":"pre-tool-use","tool":"Bash","command":"git status"}}"""
    );

    [Fact]
    public async Task SendAsync_ManyConcurrentCalls_ShareOneConnectionAndMatchResponsesById()
    {
        await using var server = new EchoPluginServer();
        await using var pool = PoolFor(server);
        var connection = await pool.GetAsync("echo", CancellationToken.None);

        var calls = Enumerable
            .Range(0, 64)
            .Select(async i =>
            {
                var body = Encoding.UTF8.GetBytes($"{{\"n\":{i}}}");
                var id = connection.NextRequestId();
                using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, id, body);
                var response = await connection.SendAsync(frame.Memory, CancellationToken.None);
                return (id, i, response);
            })
            .ToArray();
        var results = await Task.WhenAll(calls);

        await SpinUntil(() => server.Accepted >= 1);
        Assert.Equal(1, server.Accepted);
        foreach (var (id, i, response) in results)
        {
            Assert.Equal(id, response.Header.RequestId);
            Assert.Equal($"{{\"n\":{i}}}", Encoding.UTF8.GetString(response.Payload.Span));
            Assert.True((response.Header.Flags & FrameFlags.Response) != 0);
        }
    }

    [Fact]
    public async Task GetAsync_SecondCall_ReusesWarmConnection()
    {
        await using var server = new EchoPluginServer();
        await using var pool = PoolFor(server);

        var first = await pool.GetAsync("echo", CancellationToken.None);
        var second = await pool.GetAsync("echo", CancellationToken.None);

        Assert.Same(first, second);
        await SpinUntil(() => server.Accepted >= 1);
        Assert.Equal(1, server.Accepted);
    }

    [Fact]
    public async Task GetAsync_AfterServerDropsConnection_Reconnects()
    {
        await using var server = new EchoPluginServer();
        await using var pool = PoolFor(server);
        var first = await pool.GetAsync("echo", CancellationToken.None);
        await Call(first);

        server.DropClients();
        await SpinUntil(() => !first.IsUsable);
        var second = await pool.GetAsync("echo", CancellationToken.None);

        Assert.NotSame(first, second);
        await Call(second);
        await SpinUntil(() => server.Accepted >= 2);
        Assert.Equal(2, server.Accepted);
    }

    [Fact]
    public async Task SendAsync_DuplicateRequestIdInFlight_Throws()
    {
        await using var connection = new PluginConnection(new SilentStream());
        using var first = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, 5, "{}"u8);
        using var again = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, 5, "{}"u8);
        using var cts = new CancellationTokenSource();
        var pending = connection.SendAsync(first.Memory, cts.Token).AsTask();

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () => await connection.SendAsync(again.Memory, CancellationToken.None));

        Assert.Equal("duplicate-request-id", ex.Code);
        await cts.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
    }

    [Fact]
    public async Task SendAsync_Canceled_ThrowsAndConnectionStaysUsable()
    {
        await using var server = new EchoPluginServer();
        await using var pool = PoolFor(server);
        var connection = await pool.GetAsync("echo", CancellationToken.None);
        using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, connection.NextRequestId(), "{}"u8);
        using var canceled = new CancellationTokenSource();
        await canceled.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await connection.SendAsync(frame.Memory, canceled.Token));

        Assert.True(connection.IsUsable);
        await Call(connection);
    }

    [Fact]
    public async Task ConnectAsync_SocketWithGroupAccess_IsRefused()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix socket modes");
        await using var server = new EchoPluginServer(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead);
        var connector = new IpcConnector(new FixedResolver(server.SocketPath));

        var ex = await Assert.ThrowsAsync<DgException>(async () => await connector.ConnectAsync("echo", CancellationToken.None));

        Assert.Equal("ipc-insecure", ex.Error.Key);
        Assert.Contains("0600", ex.Error.Message);
        Assert.Equal(0, server.Accepted);
    }

    [Fact]
    public async Task ConnectAsync_MissingSocket_IsRefusedWithNextStep()
    {
        var connector = new IpcConnector(new FixedResolver(Path.Combine(Path.GetTempPath(), "dg-missing-" + Guid.NewGuid().ToString("N"))));

        var ex = await Assert.ThrowsAsync<DgException>(async () => await connector.ConnectAsync("echo", CancellationToken.None));

        Assert.Contains("not found", ex.Error.Message);
        Assert.Contains("start the plugin", ex.Error.NextStep);
    }

    [Fact]
    public async Task ConnectAsync_SymbolicLinkToSocket_IsRefused()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix socket modes");
        await using var server = new EchoPluginServer();
        var link = Path.Combine(server.Directory, "link.sock");
        File.CreateSymbolicLink(link, server.SocketPath);
        var connector = new IpcConnector(new FixedResolver(link));

        var ex = await Assert.ThrowsAsync<DgException>(async () => await connector.ConnectAsync("echo", CancellationToken.None));

        Assert.Contains("symbolic link", ex.Error.Message);
    }

    [Fact]
    public async Task ConnectAsync_PrivateSocketOwnedByCurrentUser_Connects()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix socket modes");
        await using var server = new EchoPluginServer();
        var connector = new IpcConnector(new FixedResolver(server.SocketPath));

        await using var stream = await connector.ConnectAsync("echo", CancellationToken.None);

        Assert.True(stream.CanWrite);
    }

    [Theory]
    [InlineData("S-1-5-21-1", "S-1-5-21-1", new[] { "S-1-5-21-1" }, true)]
    [InlineData("S-1-5-21-1", "S-1-5-21-1", new[] { "S-1-5-21-1", "S-1-5-18", "S-1-5-32-544" }, true)]
    [InlineData("S-1-5-21-1", "S-1-5-21-1", new[] { "S-1-5-21-1", "S-1-1-0" }, false)]
    [InlineData("S-1-5-21-1", "S-1-5-21-2", new[] { "S-1-5-21-1" }, false)]
    [InlineData("S-1-5-21-1", "S-1-5-21-1", new[] { "S-1-5-21-1", "S-1-5-21-3" }, false)]
    public void IsUserOnly_AllowRules_GrantsOnlyCurrentUser(string user, string owner, string[] allowed, bool expected)
    {
        var rules = allowed.Select(sid => (sid, true));

        Assert.Equal(expected, PipeAclPolicy.IsUserOnly(user, owner, rules));
    }

    [Fact]
    public void IsUserOnly_DenyRuleForOtherUser_IsIgnored()
    {
        Assert.True(PipeAclPolicy.IsUserOnly("S-1-5-21-1", "S-1-5-21-1", [("S-1-5-21-1", true), ("S-1-1-0", false)]));
    }

    [Fact]
    public void AddIpcTransport_RegistersConnectorAndPool()
    {
        var services = new FakeServices();

        var returned = services.AddIpcTransport();

        Assert.Same(services, returned);
        Assert.Equal([typeof(IpcConnector), typeof(PluginConnectionPool)], services.Select(d => d.ServiceType).ToArray());
        Assert.All(services, d => Assert.Equal(ServiceLifetime.Singleton, d.Lifetime));
    }

    [Fact]
    public async Task SendAsync_WarmConnection_P50StaysWithinIpcBudget()
    {
        await using var server = new EchoPluginServer();
        await using var pool = PoolFor(server);
        var connection = await pool.GetAsync("echo", CancellationToken.None);
        for (var i = 0; i < 200; i++)
            await Call(connection);

        var samples = new double[300];
        for (var i = 0; i < samples.Length; i++)
        {
            var start = Stopwatch.GetTimestamp();
            await Call(connection);
            samples[i] = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
        }
        Array.Sort(samples);
        var p50 = samples[150];
        var p99 = samples[296];
        TestContext.Current.SendDiagnosticMessage($"warm ipc p50={p50:F4} ms p99={p99:F4} ms over {samples.Length} calls");

        Assert.True(p50 < PluginRoutes.HookLatencyBudgetP99Ms.Ipc, $"p50 {p50:F4} ms is over the {PluginRoutes.HookLatencyBudgetP99Ms.Ipc} ms IPC budget");
    }

    private static PluginConnectionPool PoolFor(EchoPluginServer server) =>
        new(new IpcConnector(new FixedResolver(server.SocketPath)).ConnectAsync);

    private static async Task Call(PluginConnection connection)
    {
        using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, connection.NextRequestId(), HookMessage);
        var response = await connection.SendAsync(frame.Memory, CancellationToken.None);
        Assert.Equal(HookMessage.Length, response.Payload.Length);
    }

    private static async Task<bool> Settle(ValueTask<PluginResponse> call)
    {
        try
        {
            await call;
            return true;
        }
        catch (PluginContractException)
        {
            return false;
        }
    }

    private static async Task SpinUntil(Func<bool> condition)
    {
        var deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 5;
        while (!condition())
        {
            if (Stopwatch.GetTimestamp() > deadline)
                throw new XunitException("condition not met within 5 s");
            await Task.Delay(5);
        }
    }

    private sealed class SilentStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) { }
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) => Task.CompletedTask;
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) => ValueTask.CompletedTask;

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        {
            await Task.Delay(Timeout.Infinite, ct);
            return 0;
        }
    }

    private sealed class FixedResolver(string path) : IIpcEndpointResolver
    {
        public string SocketPath(string plugin) => path;
    }

    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;
}

using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Transport.Http;
using Dg.Core.Tests.Transport.Ipc;
using Dg.Core.Tests.Transport.Tcp;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class PluginHostTests
{
    private const string Enabled = "[plugins.scanner]\nenabled = true\n";

    private static string IpcManifest(string socket) =>
        $"""
        name = "scanner"
        version = "1.0.0"
        kind = "hook"
        transport = "ipc"
        endpoint = "{socket}"
        [entry]
        command = "scanner"
        """;

    private static string TcpManifest(int port) =>
        $"""
        name = "scanner"
        version = "1.0.0"
        kind = "hook"
        transport = "tcp"
        endpoint = "127.0.0.1:{port}"
        [entry]
        command = "scanner"
        """;

    private static string HttpManifest(int port) =>
        $"""
        name = "scanner"
        version = "1.0.0"
        kind = "hook"
        transport = "http"
        endpoint = "http://127.0.0.1:{port}"
        [entry]
        command = "scanner"
        """;

    [Fact]
    public async Task InvokeAsync_EnabledApprovedIpcPlugin_ReturnsPluginReply()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Windows dials a named pipe, and the echo server listens on a Unix socket");
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", IpcManifest(EchoPluginServer.SocketFile), approved: true);
        var host = fixture.Host(Enabled);

        var response = await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None);

        Assert.True((response.Header.Flags & FrameFlags.Response) != 0);
        Assert.Contains("pre-tool-use", System.Text.Encoding.UTF8.GetString(response.Payload.Span));
        Assert.Equal(1, server.Accepted);
    }

    [Fact]
    public async Task InvokeAsync_EnabledApprovedTcpPlugin_ConnectsWithoutToken()
    {
        await using var server = new TcpPluginServer();
        await using var fixture = new RuntimeFixture();
        fixture.Install("scanner", TcpManifest(server.Port), approved: true);
        var host = fixture.Host(Enabled);

        await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None);

        Assert.Equal(1, server.Accepted);
        Assert.Equal(0, server.Rejected);
    }

    [Fact]
    public async Task InvokeAsync_TcpPluginWithStoredToken_IsRefusedAndNothingConnects()
    {
        await using var server = new TcpPluginServer();
        await using var fixture = new RuntimeFixture();
        fixture.Install("scanner", TcpManifest(server.Port), approved: true);
        fixture.SetCredential("plugin-scanner-token", "tok");
        var host = fixture.Host(Enabled);

        var ex = await Assert.ThrowsAsync<PluginTransportException>(async () =>
            await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(PluginTransportCodes.Refused, ex.Code);
        Assert.Equal(0, server.Accepted);
    }

    [Theory]
    [InlineData("ipc", true)]
    [InlineData("ipc", false)]
    [InlineData("tcp", true)]
    [InlineData("tcp", false)]
    [InlineData("http", true)]
    [InlineData("http", false)]
    public async Task InvokeAsync_DisabledOrUnapproved_ConnectsNothing(string transport, bool disabled)
    {
        await using var fixture = new RuntimeFixture();
        await using var ipc = new EchoPluginServer(directory: fixture.Folder("scanner"));
        await using var tcp = new TcpPluginServer();
        using var http = new CountingListener();
        var manifest = transport switch
        {
            "ipc" => IpcManifest(EchoPluginServer.SocketFile),
            "tcp" => TcpManifest(tcp.Port),
            _ => HttpManifest(http.Port),
        };
        fixture.Install("scanner", manifest, approved: disabled);
        fixture.SetCredential("plugin-scanner-token", "tok");
        var host = fixture.Host(disabled ? "[plugins.scanner]\nenabled = false\n" : Enabled);

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(disabled ? PluginRuntimeCodes.Disabled : PluginRuntimeCodes.Unapproved, ex.Code);
        await Task.Delay(50, TestContext.Current.CancellationToken);
        Assert.Equal(0, ipc.Accepted);
        Assert.Equal(0, tcp.Accepted);
        Assert.Equal(0, http.Accepted);
    }

    [Fact]
    public async Task InvokeAsync_NoConfigSection_IsDisabledAndConnectsNothing()
    {
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", IpcManifest(EchoPluginServer.SocketFile), approved: true);
        var host = fixture.Host("");

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(PluginRuntimeCodes.Disabled, ex.Code);
        Assert.Equal(0, server.Accepted);
    }

    [Fact]
    public async Task InvokeAsync_FilesChangedAfterApproval_IsUnapprovedAndConnectsNothing()
    {
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", IpcManifest(EchoPluginServer.SocketFile), approved: true);
        fixture.Tamper("scanner");
        var host = fixture.Host(Enabled);

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(PluginRuntimeCodes.Unapproved, ex.Code);
        Assert.Equal(0, server.Accepted);
    }

    [Fact]
    public Task InvokeAsync_ApprovalKeyMissingFromTheStore_IsUnapprovedAndConnectsNothing() =>
        AssertUnapprovedAsync(static fixture => fixture.RemoveCredential(PluginApproval.KeyCredential));

    [Fact]
    public Task InvokeAsync_ApprovalSignedByAnotherKey_IsUnapprovedAndConnectsNothing() =>
        AssertUnapprovedAsync(static fixture =>
            fixture.SetCredential(PluginApproval.KeyCredential, new string('a', 64))
        );

    [Fact]
    public Task InvokeAsync_UnsignedApproval_IsUnapprovedAndConnectsNothing() =>
        AssertUnapprovedAsync(static fixture => fixture.Unsign("scanner"));

    private static async Task AssertUnapprovedAsync(Action<RuntimeFixture> breakApproval)
    {
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", IpcManifest(EchoPluginServer.SocketFile), approved: true);
        breakApproval(fixture);
        var host = fixture.Host(Enabled);

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(PluginRuntimeCodes.Unapproved, ex.Code);
        Assert.Contains("dg plugin verify scanner --approve", ex.Message);
        Assert.Equal(0, server.Accepted);
    }

    [Fact]
    public async Task InvokeAsync_NotInstalled_Throws()
    {
        await using var fixture = new RuntimeFixture();
        var host = fixture.Host(Enabled);

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(PluginRuntimeCodes.NotInstalled, ex.Code);
    }

    [Fact]
    public async Task InvokeAsync_PathTraversalName_IsRefused()
    {
        await using var fixture = new RuntimeFixture();
        var host = fixture.Host(Enabled);

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.InvokeAsync("../x", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(PluginRuntimeCodes.BadName, ex.Code);
    }

    [Fact]
    public async Task InvokeAsync_UdpManifest_IsEventsOnly()
    {
        await using var fixture = new RuntimeFixture();
        fixture.Install(
            "scanner",
            """
            name = "scanner"
            version = "1.0.0"
            kind = "job"
            transport = "udp"
            endpoint = "127.0.0.1:9"
            [entry]
            command = "scanner"
            """,
            approved: true
        );
        var host = fixture.Host(Enabled);

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.InvokeAsync("scanner", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(PluginRuntimeCodes.EventsOnly, ex.Code);
    }

    [Fact]
    public async Task InvokeAsync_BuiltinName_RunsInProcessWithoutConfigOrFiles()
    {
        await using var fixture = new RuntimeFixture();
        var builtin = new EchoBuiltin();
        var host = fixture.Host("", builtin);

        var response = await host.InvokeAsync("echo", RuntimeFixture.HookMessage(), CancellationToken.None);

        Assert.Equal(PluginRoutes.HookDecide, builtin.LastRoute);
        Assert.Equal(7u, response.Header.RequestId);
    }

    [Fact]
    public async Task HealthAsync_PluginReplyIsNotAHealthBody_ThrowsBadReply()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Windows dials a named pipe, and the echo server listens on a Unix socket");
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", IpcManifest(EchoPluginServer.SocketFile), approved: true);
        var host = fixture.Host(Enabled);

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.HealthAsync("scanner", CancellationToken.None)
        );

        Assert.Equal(PluginRuntimeCodes.BadReply, ex.Code);
    }

    [Fact]
    public async Task HealthAsync_Unapproved_ConnectsNothing()
    {
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", IpcManifest(EchoPluginServer.SocketFile), approved: false);
        var host = fixture.Host(Enabled);

        await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.HealthAsync("scanner", CancellationToken.None)
        );

        Assert.Equal(0, server.Accepted);
    }

    private sealed class EchoBuiltin : IBuiltinPlugin
    {
        public string Name => "echo";

        public string? LastRoute { get; private set; }

        public ValueTask<PluginResponse> HandleAsync(PluginEnvelope message, CancellationToken ct)
        {
            LastRoute = message.Route;
            return ValueTask.FromResult(
                new PluginResponse(
                    new FrameHeader(PluginProtocol.Version, FrameEncoding.Json, FrameFlags.Response, 7, 2),
                    "{}"u8.ToArray()
                )
            );
        }
    }

    private sealed class CountingListener : IDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private int _accepted;

        public CountingListener()
        {
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _ = Task.Run(async () =>
            {
                try
                {
                    while (true)
                    {
                        using var _ = await _listener.AcceptTcpClientAsync(_stop.Token);
                        Interlocked.Increment(ref _accepted);
                    }
                }
                catch (Exception) { }
            });
        }

        public int Port { get; }

        public int Accepted => Volatile.Read(ref _accepted);

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Stop();
        }
    }

    [Fact]
    public async Task InvokeAsync_BuiltinDisabledInConfig_IsRefused()
    {
        await using var fixture = new RuntimeFixture();
        var builtin = new EchoBuiltin();
        var host = fixture.Host("[plugins.echo]\nenabled = false\n", builtin);

        var ex = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await host.InvokeAsync("echo", RuntimeFixture.HookMessage(), CancellationToken.None)
        );

        Assert.Equal(PluginRuntimeCodes.Disabled, ex.Code);
    }
}

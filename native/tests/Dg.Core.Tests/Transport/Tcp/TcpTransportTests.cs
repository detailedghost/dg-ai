using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Http;
using Dg.Core.Transport.Pool;
using Dg.Core.Transport.Tcp;
using Microsoft.Extensions.DependencyInjection;
using static Dg.Core.Tests.Transport.TransportTestSupport;

namespace Dg.Core.Tests.Transport.Tcp;

public sealed class TcpTransportTests
{
    private const string Secret = "s3cret-token";

    private static PluginManifest Manifest(
        string? endpoint,
        bool remote = false,
        PluginTransportKind transport = PluginTransportKind.Tcp
    ) =>
        new(
            "scanner",
            "1.0.0",
            PluginKind.Hook,
            transport,
            endpoint,
            remote,
            null,
            null,
            new(null, "scanner", []),
            new(false, [], [], []),
            new([], [])
        );

    private static TcpConnector ConnectorFor(PluginManifest manifest, string? token = Secret) =>
        new(new FixedManifests(manifest), new FixedTokens(token));

    private static PluginManifest ManifestFor(TcpPluginServer server) => Manifest($"127.0.0.1:{server.Port}");

    [Fact]
    public async Task ConnectAsync_ValidToken_CompletesHelloAndEchoesFrames()
    {
        await using var server = new TcpPluginServer(Secret);
        await using var pool = new PluginConnectionPool(ConnectorFor(ManifestFor(server)).ConnectAsync);

        var connection = await pool.GetAsync("scanner", CancellationToken.None);
        await Call(connection);

        Assert.Equal(1, server.Accepted);
        Assert.Equal(0, server.Rejected);
    }

    [Fact]
    public async Task ConnectAsync_WrongToken_PluginClosesConnectionAndCallerGetsAuthError()
    {
        await using var server = new TcpPluginServer(Secret);
        var connector = ConnectorFor(ManifestFor(server), token: "wrong");

        var ex = await Assert.ThrowsAsync<PluginTransportException>(async () => await connector.ConnectAsync("scanner", CancellationToken.None));

        Assert.Equal(PluginTransportCodes.Auth, ex.Code);
        Assert.Equal(1, server.Rejected);
        Assert.DoesNotContain("wrong", ex.Message);
    }

    [Fact]
    public async Task ConnectAsync_NoStoredToken_FailsBeforeConnecting()
    {
        await using var server = new TcpPluginServer(Secret);
        var connector = ConnectorFor(ManifestFor(server), token: null);

        var ex = await Assert.ThrowsAsync<PluginTransportException>(async () => await connector.ConnectAsync("scanner", CancellationToken.None));

        Assert.Equal(PluginTransportCodes.Auth, ex.Code);
        Assert.Contains("plugin-scanner-token", ex.Message);
        Assert.Equal(0, server.Accepted);
    }

    [Fact]
    public async Task ConnectAsync_NothingListening_IsUnreachable()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Windows retries a refused loopback connect for about 2 s, past the 1 s connect budget");
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        var connector = ConnectorFor(Manifest($"127.0.0.1:{port}"));

        var ex = await Assert.ThrowsAsync<PluginTransportException>(async () => await connector.ConnectAsync("scanner", CancellationToken.None));

        Assert.Equal(PluginTransportCodes.Unreachable, ex.Code);
    }

    [Fact]
    public async Task ConnectAsync_PoolReconnectsAfterRejectedHello()
    {
        await using var server = new TcpPluginServer(Secret);
        var tokens = new FixedTokens("wrong");
        await using var pool = new PluginConnectionPool(new TcpConnector(new FixedManifests(ManifestFor(server)), tokens).ConnectAsync);

        await Assert.ThrowsAsync<PluginTransportException>(async () => await pool.GetAsync("scanner", CancellationToken.None));
        tokens.Token = Secret;
        var connection = await pool.GetAsync("scanner", CancellationToken.None);

        await Call(connection);
    }

    [Theory]
    [InlineData("127.0.0.1:9000", false, PluginTransportKind.Tcp, true)]
    [InlineData("[::1]:9000", false, PluginTransportKind.Tcp, true)]
    [InlineData("203.0.113.5:9000", false, PluginTransportKind.Tcp, false)]
    [InlineData("localhost:9000", false, PluginTransportKind.Tcp, true)]
    [InlineData("127.0.0.1", false, PluginTransportKind.Tcp, false)]
    [InlineData("127.0.0.1:0", false, PluginTransportKind.Tcp, false)]
    [InlineData(null, false, PluginTransportKind.Tcp, false)]
    [InlineData("127.0.0.1:9000", true, PluginTransportKind.Tcp, false)]
    [InlineData("127.0.0.1:9000", false, PluginTransportKind.Http, false)]
    public void Resolve_Manifest_AcceptsOnlyLocalTcpEndpoints(string? endpoint, bool remote, PluginTransportKind transport, bool accepted)
    {
        var manifest = Manifest(endpoint, remote, transport);

        if (accepted)
        {
            Assert.True(IPAddress.IsLoopback(TcpEndpointGuard.Resolve(manifest).Address));
            return;
        }
        var ex = Assert.Throws<PluginTransportException>(() => TcpEndpointGuard.Resolve(manifest));
        Assert.Equal(PluginTransportCodes.Refused, ex.Code);
    }

    [Fact]
    public async Task ConnectAsync_RemoteEndpoint_IsRefusedWithoutConnecting()
    {
        var connector = ConnectorFor(Manifest("203.0.113.5:9000"));

        var ex = await Assert.ThrowsAsync<PluginTransportException>(async () => await connector.ConnectAsync("scanner", CancellationToken.None));

        Assert.Equal(PluginTransportCodes.Refused, ex.Code);
    }

    [Fact]
    public void AddTcpTransport_RegistersConnectorAndKeyedPool()
    {
        var services = new FakeServices();

        var returned = services.AddTcpTransport();

        Assert.Same(services, returned);
        Assert.Contains(services, d => d.ServiceType == typeof(TcpConnector) && d.Lifetime == ServiceLifetime.Singleton);
        Assert.Contains(
            services,
            d => d.ServiceType == typeof(PluginConnectionPool) && d.IsKeyedService && Equals(d.ServiceKey, TcpTransportKeys.Pool)
        );
        Assert.DoesNotContain(services, d => d.ServiceType == typeof(PluginConnectionPool) && !d.IsKeyedService);
    }

    private sealed class FixedManifests(PluginManifest manifest) : ITcpManifestResolver
    {
        public PluginManifest Manifest(string plugin) => manifest;
    }

    private sealed class FixedTokens(string? token) : IPluginTokenProvider
    {
        public string? Token { get; set; } = token;

        public ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct) => ValueTask.FromResult(Token);
    }

    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;
}

using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Dg.Core.Tests.Transport.Http;

public sealed class HttpTransportTests(Xunit.ITestOutputHelper output)
{
    private const string Secret = "tok-SECRET-123";
    private const string DecideBody = """{"route":"/v1/hook/decide","body":{"event":"pre"}}""";
    private const string AllowReply = """{"decision":"allow"}""";

    private sealed class FakeTokens(string? token = Secret, Exception? failure = null) : IPluginTokenProvider
    {
        public List<string> Asked { get; } = [];

        public ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct)
        {
            Asked.Add(credentialName);
            return failure is null ? new(token) : throw failure;
        }
    }

    private static PluginManifest Manifest(string endpoint, bool remote = false, PluginTransportKind kind = PluginTransportKind.Http) =>
        new(
            "secret-scan",
            "1.0.0",
            PluginKind.Hook,
            kind,
            endpoint,
            remote,
            null,
            null,
            new PluginEntry(null, "plugin", []),
            new PluginCapabilities(false, [], [], []),
            new PluginPermissions([], [])
        );

    private static byte[] Frame(string payload, uint id = 7) =>
        FrameCodec.Encode(FrameEncoding.Json, FrameFlags.None, id, Encoding.UTF8.GetBytes(payload));

    private static HttpTransport Create(string endpoint, FakeTokens? tokens = null) =>
        new(Manifest(endpoint), allowRemote: false, tokens ?? new FakeTokens());

    private static async Task<PluginTransportException> FailureOf(HttpTransport transport, string payload = DecideBody) =>
        await Assert.ThrowsAsync<PluginTransportException>(async () =>
            await transport.SendAsync(Frame(payload), CancellationToken.None)
        );

    [Fact]
    public async Task SendAsync_HookDecide_PostsBodyWithBearerAndReturnsResponseFrame()
    {
        await using var server = new LoopbackServer(_ => new Reply(Body: AllowReply));
        var tokens = new FakeTokens();
        await using var transport = Create(server.Endpoint + "/base/", tokens);

        var response = await transport.SendAsync(Frame(DecideBody), CancellationToken.None);

        var seen = Assert.Single(server.Seen);
        Assert.Equal("POST", seen.Method);
        Assert.Equal("/base/v1/hook/decide", seen.Path);
        Assert.Equal($"Bearer {Secret}", seen.Headers["Authorization"]);
        Assert.StartsWith("application/json", seen.Headers["Content-Type"]);
        Assert.Equal("""{"event":"pre"}""", seen.Body);
        Assert.Equal(["plugin-secret-scan-token"], tokens.Asked);
        Assert.Equal(new FrameHeader(1, FrameEncoding.Json, FrameFlags.Response, 7, (uint)AllowReply.Length), response.Header);
        Assert.Equal(AllowReply, Encoding.UTF8.GetString(response.Payload.Span));
    }

    [Fact]
    public async Task SendAsync_RepeatedCalls_ReuseOneConnectionAndOneTokenLookup()
    {
        await using var server = new LoopbackServer(_ => new Reply(Body: AllowReply));
        var tokens = new FakeTokens();
        await using var transport = Create(server.Endpoint, tokens);

        for (var i = 0; i < 5; i++)
            await transport.SendAsync(Frame(DecideBody), CancellationToken.None);

        Assert.Equal(1, server.Connections);
        Assert.Equal(5, server.Seen.Count);
        Assert.Single(tokens.Asked);
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    public async Task SendAsync_AuthRejected_ThrowsAuthAndFetchesTokenAgain(int status)
    {
        await using var server = new LoopbackServer(_ => new Reply(Status: status, Body: """{"code":"no","message":"no"}"""));
        var tokens = new FakeTokens();
        await using var transport = Create(server.Endpoint, tokens);

        var first = await FailureOf(transport);
        await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Auth, first.Code);
        Assert.Contains($"HTTP {status}", first.Message);
        Assert.Equal(2, tokens.Asked.Count);
    }

    [Fact]
    public async Task SendAsync_NoStoredToken_ThrowsAuthWithoutCallingServer()
    {
        await using var server = new LoopbackServer(_ => new Reply());
        await using var transport = Create(server.Endpoint, new FakeTokens(token: null));

        var error = await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Auth, error.Code);
        Assert.Contains("dg credentials set plugin-secret-scan-token", error.Message);
        Assert.Empty(server.Seen);
    }

    [Fact]
    public async Task SendAsync_TokenProviderThrows_ThrowsAuthWithoutProviderText()
    {
        await using var transport = Create("http://127.0.0.1:1", new FakeTokens(failure: new InvalidOperationException("vault leaked hunter2")));

        var error = await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Auth, error.Code);
        Assert.DoesNotContain("hunter2", error.Message);
    }

    [Fact]
    public async Task SendAsync_PluginErrorStatus_ThrowsPluginWithCodeAndMessage()
    {
        await using var server = new LoopbackServer(_ => new Reply(Status: 500, Body: """{"code":"boom","message":"it broke"}"""));
        await using var transport = Create(server.Endpoint);

        var error = await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Plugin, error.Code);
        Assert.Equal("dg plugin: secret-scan: boom: it broke", error.Message);
    }

    [Fact]
    public async Task SendAsync_PluginErrorEchoesToken_RedactsIt()
    {
        await using var server = new LoopbackServer(r =>
            new Reply(Status: 500, Body: $$"""{"code":"echo","message":"you sent {{r.Headers["Authorization"]}}"}""")
        );
        await using var transport = Create(server.Endpoint);

        var error = await FailureOf(transport);

        Assert.DoesNotContain(Secret, error.Message);
        Assert.Contains("[redacted]", error.Message);
    }

    [Fact]
    public async Task SendAsync_ResponseNotJsonObject_ThrowsPlugin()
    {
        await using var server = new LoopbackServer(_ => new Reply(Body: "[1]"));
        await using var transport = Create(server.Endpoint);

        var error = await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Plugin, error.Code);
    }

    [Fact]
    public async Task SendAsync_ResponseBreaksContract_ThrowsContractErrorWithoutToken()
    {
        await using var server = new LoopbackServer(_ => new Reply(Body: $$"""{"decision":"{{Secret}}"}"""));
        await using var transport = Create(server.Endpoint);

        var error = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await transport.SendAsync(Frame(DecideBody), CancellationToken.None)
        );

        Assert.Equal("message", error.Code);
        Assert.DoesNotContain(Secret, error.Message);
    }

    [Fact]
    public async Task SendAsync_DeclaredLengthOverLimit_ThrowsOversize()
    {
        var head = $"HTTP/1.1 200 OK\r\nContent-Length: {PluginProtocol.MaxPayloadBytes + 1}\r\n\r\n";
        await using var server = new LoopbackServer(_ => new Reply(RawHead: head, Body: "{"));
        await using var transport = Create(server.Endpoint);

        var error = await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Oversize, error.Code);
    }

    [Fact]
    public async Task SendAsync_StreamedBodyOverLimit_ThrowsOversize()
    {
        var head = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n";
        await using var server = new LoopbackServer(_ => new Reply(RawHead: head, Body: new string('x', PluginProtocol.MaxPayloadBytes + 10)));
        await using var transport = Create(server.Endpoint);

        var error = await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Oversize, error.Code);
    }

    [Fact]
    public async Task SendAsync_SlowPlugin_ThrowsTimeoutAtRouteBudget()
    {
        await using var server = new LoopbackServer(_ => new Reply(Delay: TimeSpan.FromSeconds(5)));
        await using var transport = Create(server.Endpoint);
        var watch = Stopwatch.StartNew();

        var error = await FailureOf(transport, """{"route":"/v1/health","body":{}}""");

        Assert.Equal(PluginTransportCodes.Timeout, error.Code);
        Assert.Contains("/v1/health took over 1000 ms", error.Message);
        Assert.InRange(watch.ElapsedMilliseconds, 900, 3000);
    }

    [Fact]
    public async Task SendAsync_CallerCancels_ThrowsOperationCanceled()
    {
        await using var server = new LoopbackServer(_ => new Reply(Delay: TimeSpan.FromSeconds(5)));
        await using var transport = Create(server.Endpoint);
        using var source = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await transport.SendAsync(Frame(DecideBody), source.Token)
        );
    }

    [Fact]
    public async Task SendAsync_NothingListening_ThrowsUnreachable()
    {
        int port;
        await using (var closed = new LoopbackServer(_ => new Reply()))
            port = closed.Port;
        await using var transport = Create($"http://127.0.0.1:{port}");

        var error = await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Unreachable, error.Code);
        Assert.DoesNotContain(Secret, error.Message);
    }

    [Fact]
    public async Task SendAsync_Redirect_IsNotFollowedAndTokenStaysHome()
    {
        await using var target = new LoopbackServer(_ => new Reply(Body: AllowReply));
        var head = $"HTTP/1.1 302 Found\r\nLocation: {target.Endpoint}/v1/hook/decide\r\nContent-Length: 0\r\n\r\n";
        await using var server = new LoopbackServer(_ => new Reply(RawHead: head, Body: ""));
        await using var transport = Create(server.Endpoint);

        var error = await FailureOf(transport);

        Assert.Equal(PluginTransportCodes.Unreachable, error.Code);
        Assert.Empty(target.Seen);
    }

    [Fact]
    public async Task SendAsync_UnknownRoute_ThrowsContractError()
    {
        await using var transport = Create("http://127.0.0.1:1");

        var error = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await transport.SendAsync(Frame("""{"route":"/v2/x","body":{}}"""), CancellationToken.None)
        );

        Assert.Equal("message", error.Code);
    }

    [Fact]
    public async Task SendAsync_InvalidRequestBody_ThrowsContractErrorAndSendsNothing()
    {
        await using var server = new LoopbackServer(_ => new Reply());
        await using var transport = Create(server.Endpoint);

        await Assert.ThrowsAsync<PluginContractException>(async () =>
            await transport.SendAsync(Frame("""{"route":"/v1/hook/decide","body":{}}"""), CancellationToken.None)
        );

        Assert.Empty(server.Seen);
    }

    [Fact]
    public async Task SendAsync_AnyOutcome_NeverPutsTokenInUrl()
    {
        await using var server = new LoopbackServer(_ => new Reply(Body: AllowReply));
        await using var transport = Create(server.Endpoint);

        await transport.SendAsync(Frame(DecideBody), CancellationToken.None);

        Assert.All(server.Seen, request => Assert.DoesNotContain(Secret, request.Path));
        Assert.DoesNotContain(Secret, server.Endpoint);
    }

    [Theory]
    [InlineData("http://example.com", false, false, "is not loopback")]
    [InlineData("https://example.com", false, false, "is not loopback")]
    [InlineData("ftp://127.0.0.1", false, false, "http or https")]
    [InlineData("not a url", false, false, "not a URL")]
    [InlineData("http://user:pw@127.0.0.1:9", false, false, "must not hold credentials")]
    [InlineData("http://127.0.0.1:9/p?token=abc", false, false, "query or fragment")]
    [InlineData("https://example.com", true, false, "allow_remote is not true")]
    [InlineData("http://example.com", true, true, "must use https")]
    public void Constructor_EndpointBreaksRules_ThrowsRefused(string endpoint, bool remote, bool allowRemote, string expected)
    {
        var error = Assert.Throws<PluginTransportException>(() => new HttpTransport(Manifest(endpoint, remote), allowRemote, new FakeTokens()));

        Assert.Equal(PluginTransportCodes.Refused, error.Code);
        Assert.Contains(expected, error.Message);
        Assert.DoesNotContain("pw@", error.Message);
        Assert.DoesNotContain("token=abc", error.Message);
    }

    [Fact]
    public void Constructor_NotHttpTransport_ThrowsRefused()
    {
        var error = Assert.Throws<PluginTransportException>(() =>
            new HttpTransport(Manifest("http://127.0.0.1:9", kind: PluginTransportKind.Ipc), false, new FakeTokens())
        );

        Assert.Equal(PluginTransportCodes.Refused, error.Code);
    }

    [Theory]
    [InlineData("http://127.0.0.1:9")]
    [InlineData("http://localhost:9")]
    [InlineData("http://[::1]:9")]
    public async Task Constructor_LoopbackHost_Accepted(string endpoint)
    {
        await using var transport = Create(endpoint);

        Assert.NotNull(transport);
    }

    [Fact]
    public async Task Constructor_RemoteHttpsWithAllowRemote_Accepted()
    {
        await using var transport = new HttpTransport(Manifest("https://plugins.example.com/api", remote: true), true, new FakeTokens());

        Assert.NotNull(transport);
    }

    [Fact]
    public void AddHttpTransport_RegistersFactory()
    {
        var services = new ServiceCollection().AddHttpTransport();

        var descriptor = Assert.Single(services, d => d.ServiceType == typeof(IHttpTransportFactory));
        Assert.Equal(typeof(HttpTransportFactory), descriptor.ImplementationType);
    }

    [Fact]
    public async Task Factory_Create_ReturnsWorkingTransport()
    {
        await using var server = new LoopbackServer(_ => new Reply(Body: AllowReply));
        await using var transport = new HttpTransportFactory(new FakeTokens()).Create(Manifest(server.Endpoint), false);

        var response = await transport.SendAsync(Frame(DecideBody), CancellationToken.None);

        Assert.Equal(FrameFlags.Response, response.Header.Flags);
    }

    [Fact]
    public async Task SendAsync_ThreeHundredKeepAliveCalls_P50UnderOneMillisecond()
    {
        await using var server = new LoopbackServer(_ => new Reply(Body: AllowReply));
        await using var transport = Create(server.Endpoint);
        var frame = Frame(DecideBody);
        for (var i = 0; i < 50; i++)
            await transport.SendAsync(frame, CancellationToken.None);
        var samples = new double[300];

        for (var i = 0; i < samples.Length; i++)
        {
            var start = Stopwatch.GetTimestamp();
            await transport.SendAsync(frame, CancellationToken.None);
            samples[i] = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
        }

        Array.Sort(samples);
        output.WriteLine($"p50={samples[150]:F3} ms p99={samples[297]:F3} ms");
        Assert.Equal(1, server.Connections);
        Assert.True(samples[150] < 1.0, $"p50 was {samples[150]:F3} ms");
    }

    [Fact]
    public async Task SendAsync_PayloadIsNotJson_ThrowsContractException()
    {
        await using var transport = Create("http://127.0.0.1:1");

        var error = await Assert.ThrowsAsync<PluginContractException>(async () =>
            await transport.SendAsync(Frame("not json"), CancellationToken.None)
        );

        Assert.Equal("message", error.Code);
    }
}

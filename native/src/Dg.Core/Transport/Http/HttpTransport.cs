using System.Collections.Frozen;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;

namespace Dg.Core.Transport.Http;

public sealed class HttpTransport : IPluginTransport
{
    private const string Redacted = "[redacted]";
    private static readonly MediaTypeHeaderValue JsonType = new("application/json");

    private readonly string _name;
    private readonly string _credential;
    private readonly IPluginTokenProvider _tokens;
    private readonly FrozenDictionary<string, Uri> _routes;
    private readonly HttpClient _client;
    private string? _bearer;
    private string? _token;

    public HttpTransport(PluginManifest manifest, bool allowRemote, IPluginTokenProvider tokens)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(tokens);
        _routes = HttpEndpoint.Resolve(manifest, allowRemote);
        _name = manifest.Name;
        _credential = PluginRoutes.TokenCredential(_name);
        _tokens = tokens;
        _client = new HttpClient(
            new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                UseProxy = false,
                UseCookies = false,
                AutomaticDecompression = DecompressionMethods.None,
                PooledConnectionLifetime = Timeout.InfiniteTimeSpan,
                PooledConnectionIdleTimeout = TimeSpan.FromMinutes(2),
                KeepAlivePingPolicy = HttpKeepAlivePingPolicy.Always,
                ConnectTimeout = TimeSpan.FromSeconds(1),
            },
            disposeHandler: true
        )
        {
            Timeout = System.Threading.Timeout.InfiniteTimeSpan,
        };
    }

    public async ValueTask<PluginResponse> SendAsync(ReadOnlyMemory<byte> frame, CancellationToken ct)
    {
        var decoded = FrameCodec.Decode(frame);
        var envelope = JsonSerializer.Deserialize(decoded.Payload.Span, PluginJsonContext.Default.PluginEnvelope);
        if (envelope is null || envelope.Route is null)
            throw new PluginContractException("message", "dg plugin: route: the payload needs a route and a body. Next: send {\"route\": ..., \"body\": ...}.");
        var route = envelope.Route;
        MessageValidator.Validate(route, MessageDirection.Request, envelope.Body);
        if (!_routes.TryGetValue(route, out var uri))
            throw MessageValidator.UnknownRoute(route);
        var body = JsonSerializer.SerializeToUtf8Bytes(envelope.Body, PluginJsonContext.Default.JsonElement);
        if (body.Length > PluginProtocol.MaxPayloadBytes)
            throw Fail(PluginTransportCodes.Oversize, $"{_name}: request is over {PluginProtocol.MaxPayloadBytes} bytes. Next: send a smaller body.");

        var bearer = await ResolveBearerAsync(ct).ConfigureAwait(false);
        var timeout = PluginRoutes.TimeoutFor(route);
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutSource.CancelAfter(timeout);

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, uri)
            {
                Version = HttpVersion.Version11,
                Content = new ReadOnlyMemoryContent(body),
            };
            request.Content.Headers.ContentType = JsonType;
            request.Headers.TryAddWithoutValidation("Authorization", bearer);
            request.Headers.TryAddWithoutValidation("Accept", "application/json");

            using var response = await _client
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutSource.Token)
                .ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (status is >= 300 and < 400)
                throw Fail(PluginTransportCodes.Unreachable, $"{_name}: cannot reach {uri.Authority}: the plugin answered with a redirect. Next: fix endpoint in plugin.toml.");
            var bytes = await ReadCappedAsync(response, timeoutSource.Token).ConfigureAwait(false);
            if (status is 401 or 403)
            {
                _bearer = null;
                _token = null;
                throw Fail(PluginTransportCodes.Auth, $"{_name}: the plugin refused the token (HTTP {status}). Next: run dg credentials set {_credential}.");
            }
            return Complete(route, decoded.Header.RequestId, status, bytes);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested && timeoutSource.IsCancellationRequested)
        {
            throw Fail(PluginTransportCodes.Timeout, $"{_name}: {route} took over {(int)timeout.TotalMilliseconds} ms. Next: check the plugin is healthy, then retry.");
        }
        catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException)
        {
            if (ct.IsCancellationRequested)
                throw new OperationCanceledException(ct);
            throw Fail(PluginTransportCodes.Unreachable, $"{_name}: cannot reach {uri.Authority}. Next: start the plugin, then run dg plugin verify.");
        }
    }

    public ValueTask DisposeAsync()
    {
        _client.Dispose();
        return ValueTask.CompletedTask;
    }

    private PluginResponse Complete(string route, uint requestId, int status, ReadOnlyMemory<byte> bytes)
    {
        using var document = ParseObject(bytes);
        var root = document.RootElement;
        if (status is < 200 or > 299)
        {
            var code = root.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : $"http-{status}";
            var message = root.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : "no message";
            throw Fail(PluginTransportCodes.Plugin, $"{_name}: {code}: {message}");
        }
        try
        {
            MessageValidator.Validate(route, MessageDirection.Response, root);
        }
        catch (PluginContractException error)
        {
            throw new PluginContractException(error.Code, Redact(error.Message));
        }
        var header = new FrameHeader(
            PluginProtocol.Version,
            FrameEncoding.Json,
            FrameFlags.Response,
            requestId,
            (uint)bytes.Length
        );
        return new PluginResponse(header, bytes);

        JsonDocument ParseObject(ReadOnlyMemory<byte> data)
        {
            try
            {
                var parsed = JsonDocument.Parse(data);
                if (parsed.RootElement.ValueKind == JsonValueKind.Object)
                    return parsed;
                parsed.Dispose();
            }
            catch (JsonException) { }
            throw Fail(PluginTransportCodes.Plugin, $"{_name}: response is not a JSON object. Next: fix the plugin.");
        }
    }

    private async ValueTask<string> ResolveBearerAsync(CancellationToken ct)
    {
        if (_bearer is { } cached)
            return cached;
        string? token;
        try
        {
            token = await _tokens.GetTokenAsync(_credential, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            throw new PluginTransportException(
                PluginTransportCodes.Auth,
                $"{_name}: could not read credential {_credential}. Next: start dg agent, then run dg credentials set {_credential}."
            );
        }
        if (string.IsNullOrEmpty(token))
            throw new PluginTransportException(
                PluginTransportCodes.Auth,
                $"{_name}: no token stored. Next: run dg credentials set {_credential}."
            );
        _token = token;
        return _bearer = "Bearer " + token;
    }

    private async ValueTask<ReadOnlyMemory<byte>> ReadCappedAsync(HttpResponseMessage response, CancellationToken ct)
    {
        const int limit = PluginProtocol.MaxPayloadBytes;
        var declared = response.Content.Headers.ContentLength;
        if (declared > limit)
            throw Fail(PluginTransportCodes.Oversize, $"{_name}: response is {declared} bytes, the limit is {limit}. Next: have the plugin send less.");
        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        if (declared is { } exact)
        {
            var whole = new byte[(int)exact];
            await stream.ReadExactlyAsync(whole, ct).ConfigureAwait(false);
            return whole;
        }
        var buffer = new byte[4096];
        var total = 0;
        while (true)
        {
            if (total == buffer.Length)
                Array.Resize(ref buffer, (int)Math.Min((long)buffer.Length * 2, limit + 1L));
            var count = await stream.ReadAsync(buffer.AsMemory(total), ct).ConfigureAwait(false);
            if (count == 0)
                break;
            total += count;
            if (total > limit)
                throw Fail(PluginTransportCodes.Oversize, $"{_name}: response is over {limit} bytes. Next: have the plugin send less.");
        }
        return buffer.AsMemory(0, total);
    }

    private PluginTransportException Fail(string code, string message) => new(code, Redact(message));

    private string Redact(string text) =>
        _token is null ? text : text.Replace(_token, Redacted, StringComparison.Ordinal);
}

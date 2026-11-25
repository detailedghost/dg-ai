using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Http;

namespace Dg.Core.Transport.Tcp;

public sealed class TcpConnector(ITcpManifestResolver manifests, IPluginTokenProvider tokens)
{
    private const uint HelloRequestId = 1;
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(1);

    public async ValueTask<Stream> ConnectAsync(string plugin, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(plugin);
        var manifest = manifests.Manifest(plugin);
        var endpoint = TcpEndpointGuard.Resolve(manifest);
        var credential = PluginRoutes.TokenCredential(manifest.Name);
        var token = await tokens.GetTokenAsync(credential, ct).ConfigureAwait(false);
        if (string.IsNullOrEmpty(token))
            throw Fail(
                PluginTransportCodes.Auth,
                $"{manifest.Name}: no token stored. Next: run dg credentials set {credential}."
            );

        var socket = new Socket(endpoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(ConnectTimeout);
            await ConnectSocketAsync(socket, endpoint, manifest.Name, timeout.Token, ct).ConfigureAwait(false);
            var stream = new NetworkStream(socket, ownsSocket: true);
            await HelloAsync(stream, manifest.Name, credential, token, timeout, ct).ConfigureAwait(false);
            return stream;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static async Task ConnectSocketAsync(Socket socket, IPEndPoint endpoint, string name, CancellationToken linked, CancellationToken ct)
    {
        try
        {
            await socket.ConnectAsync(endpoint, linked).ConfigureAwait(false);
        }
        catch (SocketException ex)
        {
            throw Fail(PluginTransportCodes.Unreachable, $"{name}: cannot reach {endpoint} ({ex.SocketErrorCode}). Next: start the plugin.");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw Fail(PluginTransportCodes.Timeout, $"{name}: connect to {endpoint} timed out. Next: check that the plugin is running.");
        }
    }

    private static async Task HelloAsync(
        NetworkStream stream,
        string name,
        string credential,
        string token,
        CancellationTokenSource timeout,
        CancellationToken ct
    )
    {
        var hello = new HelloRequest(PluginProtocol.Version, ["json"], [], token);
        var body = JsonSerializer.SerializeToElement(hello, PluginJsonContext.Default.HelloRequest);
        var payload = JsonSerializer.SerializeToUtf8Bytes(new PluginEnvelope(PluginRoutes.Hello, body), PluginJsonContext.Default.PluginEnvelope);
        timeout.CancelAfter(PluginRoutes.TimeoutFor(PluginRoutes.Hello));
        try
        {
            using (var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, HelloRequestId, payload))
                await stream.WriteAsync(frame.Memory, timeout.Token).ConfigureAwait(false);

            var header = new byte[PluginProtocol.HeaderBytes];
            await stream.ReadExactlyAsync(header, timeout.Token).ConfigureAwait(false);
            var parsed = FrameHeader.Parse(header);
            var reply = new byte[parsed.Length];
            await stream.ReadExactlyAsync(reply, timeout.Token).ConfigureAwait(false);
            if (parsed.RequestId != HelloRequestId || (parsed.Flags & FrameFlags.Response) == 0)
                throw Fail(PluginTransportCodes.Plugin, $"{name}: hello reply did not match the request. Next: update the plugin to protocol 1.");
            ValidateReply(reply);
        }
        catch (JsonException)
        {
            throw Fail(PluginTransportCodes.Plugin, $"{name}: hello reply is not valid JSON. Next: update the plugin to protocol 1.");
        }
        catch (Exception ex) when (ex is EndOfStreamException or IOException)
        {
            throw Fail(
                PluginTransportCodes.Auth,
                $"{name}: plugin closed the connection during hello. Next: check that {credential} matches the plugin token."
            );
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw Fail(PluginTransportCodes.Timeout, $"{name}: hello timed out. Next: check that the plugin is running.");
        }
    }

    private static void ValidateReply(byte[] reply)
    {
        var envelope = JsonSerializer.Deserialize(reply, PluginJsonContext.Default.PluginEnvelope);
        if (envelope is null || envelope.Route != PluginRoutes.Hello)
            throw Fail(PluginTransportCodes.Plugin, "hello reply needs route /v1/hello. Next: update the plugin to protocol 1.");
        MessageValidator.Validate(PluginRoutes.Hello, MessageDirection.Response, envelope.Body);
    }

    private static PluginTransportException Fail(string code, string message) => new(code, message);
}

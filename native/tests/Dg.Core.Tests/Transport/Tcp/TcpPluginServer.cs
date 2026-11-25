using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;

namespace Dg.Core.Tests.Transport.Tcp;

internal sealed class TcpPluginServer : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _accept;
    private readonly string _token;
    private readonly ServerFault _fault = new();
    private int _accepted;
    private int _rejected;

    public TcpPluginServer(string token)
    {
        _token = token;
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _accept = Task.Run(AcceptLoop);
    }

    public int Port { get; }

    public int Accepted => Volatile.Read(ref _accepted);

    public int Rejected => Volatile.Read(ref _rejected);

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        _listener.Stop();
        try
        {
            await _accept;
        }
        catch (Exception ex)
        {
            _fault.Record(ex);
        }
        _fault.ThrowIfFaulted();
    }

    private async Task AcceptLoop()
    {
        try
        {
            while (true)
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                client.NoDelay = true;
                Interlocked.Increment(ref _accepted);
                _ = Task.Run(() => Serve(client));
            }
        }
        catch (Exception ex) when (!_stop.IsCancellationRequested)
        {
            _fault.Record(ex);
        }
        catch (Exception) { }
    }

    private async Task Serve(TcpClient client)
    {
        using var _ = client;
        try
        {
            var stream = client.GetStream();
            var header = new byte[PluginProtocol.HeaderBytes];
            await stream.ReadExactlyAsync(header, _stop.Token);
            var hello = FrameHeader.Parse(header);
            var payload = new byte[hello.Length];
            await stream.ReadExactlyAsync(payload, _stop.Token);
            using var doc = JsonDocument.Parse(payload);
            var token = doc.RootElement.GetProperty("body").TryGetProperty("token", out var t) ? t.GetString() : null;
            if (doc.RootElement.GetProperty("route").GetString() != PluginRoutes.Hello || token != _token)
            {
                Interlocked.Increment(ref _rejected);
                return;
            }

            var reply = Encoding.UTF8.GetBytes("""{"route":"/v1/hello","body":{"protocol":1,"encoding":"json","capabilities":[]}}""");
            using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.Response, hello.RequestId, reply);
            await stream.WriteAsync(frame.Memory, _stop.Token);

            while (true)
            {
                await stream.ReadExactlyAsync(header, _stop.Token);
                var request = FrameHeader.Parse(header);
                var body = new byte[request.Length];
                await stream.ReadExactlyAsync(body, _stop.Token);
                using var echo = FrameWriter.Encode(request.Encoding, FrameFlags.Response, request.RequestId, body);
                await stream.WriteAsync(echo.Memory, _stop.Token);
            }
        }
        catch (Exception ex)
        {
            _fault.Record(ex);
        }
    }
}

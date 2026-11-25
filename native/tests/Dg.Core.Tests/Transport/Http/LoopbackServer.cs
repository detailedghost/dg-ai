using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Dg.Core.Tests.Transport.Http;

internal sealed record SeenRequest(string Method, string Path, IReadOnlyDictionary<string, string> Headers, string Body);

internal sealed record Reply(int Status = 200, string Body = "{}", string? RawHead = null, TimeSpan? Delay = null);

internal sealed class LoopbackServer : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly Func<SeenRequest, Reply> _handler;
    private readonly CancellationTokenSource _stop = new();
    private readonly List<SeenRequest> _seen = [];
    private int _connections;

    public LoopbackServer(Func<SeenRequest, Reply> handler)
    {
        _handler = handler;
        _listener.Start();
        _ = AcceptLoopAsync();
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    public string Endpoint => $"http://127.0.0.1:{Port}";
    public int Connections => Volatile.Read(ref _connections);

    public IReadOnlyList<SeenRequest> Seen
    {
        get
        {
            lock (_seen)
                return [.. _seen];
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        _listener.Stop();
    }

    private async Task AcceptLoopAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                Interlocked.Increment(ref _connections);
                client.NoDelay = true;
                _ = ServeAsync(client);
            }
        }
        catch (Exception) when (_stop.IsCancellationRequested) { }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using var _ = client;
        var stream = client.GetStream();
        var buffer = new byte[65536];
        var filled = 0;
        try
        {
            while (true)
            {
                int headEnd;
                while ((headEnd = IndexOfHeadEnd(buffer, filled)) < 0)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(filled), _stop.Token);
                    if (read == 0)
                        return;
                    filled += read;
                }
                var head = Encoding.ASCII.GetString(buffer, 0, headEnd);
                var lines = head.Split("\r\n");
                var first = lines[0].Split(' ');
                Dictionary<string, string> headers = new(StringComparer.OrdinalIgnoreCase);
                foreach (var line in lines[1..])
                {
                    var colon = line.IndexOf(':');
                    headers[line[..colon]] = line[(colon + 1)..].Trim();
                }
                var length = headers.TryGetValue("Content-Length", out var raw) ? int.Parse(raw) : 0;
                var total = headEnd + 4 + length;
                while (filled < total)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(filled), _stop.Token);
                    if (read == 0)
                        return;
                    filled += read;
                }
                var body = Encoding.UTF8.GetString(buffer, headEnd + 4, length);
                Buffer.BlockCopy(buffer, total, buffer, 0, filled - total);
                filled -= total;
                var request = new SeenRequest(first[0], first[1], headers, body);
                lock (_seen)
                    _seen.Add(request);
                var reply = _handler(request);
                if (reply.Delay is { } delay)
                    await Task.Delay(delay, _stop.Token);
                var payload = Encoding.UTF8.GetBytes(reply.Body);
                var response = reply.RawHead is { } raw2
                    ? Encoding.ASCII.GetBytes(raw2).Concat(payload).ToArray()
                    : Encoding
                        .ASCII.GetBytes($"HTTP/1.1 {reply.Status} X\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\n\r\n")
                        .Concat(payload)
                        .ToArray();
                await stream.WriteAsync(response, _stop.Token);
            }
        }
        catch (Exception) { }
    }

    private static int IndexOfHeadEnd(byte[] buffer, int filled) =>
        buffer.AsSpan(0, filled).IndexOf("\r\n\r\n"u8);
}

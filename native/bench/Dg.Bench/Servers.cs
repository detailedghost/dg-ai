using System.Buffers;
using System.IO.Pipelines;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Runtime.Versioning;
using System.Text;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Ipc;

namespace Dg.Bench;

internal sealed class EchoServer : IAsyncDisposable
{
    private static readonly byte[] HttpHead =
        Encoding.ASCII.GetBytes(
            $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {Fixtures.AllowBody.Length}\r\n\r\n"
        );

    private readonly CancellationTokenSource _stop = new();
    private readonly Socket? _listener;
    private readonly string? _socketPath;
    private Task _loop = Task.CompletedTask;
    private Exception? _fault;

    private EchoServer(Socket? listener, string? socketPath, int port)
    {
        _listener = listener;
        _socketPath = socketPath;
        Port = port;
    }

    public int Port { get; }

    public static EchoServer StartTcp() => StartLoopback(static (stream, ct) => ServeFramesAsync(stream, ct));

    public static EchoServer StartHttp() => StartLoopback(static (stream, ct) => ServeHttpAsync(stream, ct));

    public static EchoServer StartIpc(string socketPath)
    {
        if (OperatingSystem.IsWindows())
        {
            var windows = new EchoServer(null, null, 0);
            windows._loop = windows.PipeLoopAsync();
            return windows;
        }
        var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(new UnixDomainSocketEndPoint(socketPath));
        File.SetUnixFileMode(socketPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        listener.Listen(16);
        var server = new EchoServer(listener, socketPath, 0);
        server._loop = server.AcceptLoopAsync(static (stream, ct) => ServeFramesAsync(stream, ct));
        return server;
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync().ConfigureAwait(false);
        _listener?.Dispose();
        try
        {
            await _loop.ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Record(ex);
        }
        if (_socketPath is not null)
            File.Delete(_socketPath);
        _stop.Dispose();
        if (_fault is { } fault)
            ExceptionDispatchInfo.Capture(fault).Throw();
    }

    private void Record(Exception ex)
    {
        if (ex is not (OperationCanceledException or IOException or SocketException or ObjectDisposedException or EndOfStreamException))
            Interlocked.CompareExchange(ref _fault, ex, null);
    }

    private static EchoServer StartLoopback(Func<Stream, CancellationToken, Task> serve)
    {
        var listener = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        listener.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        listener.Listen(16);
        var server = new EchoServer(listener, null, ((IPEndPoint)listener.LocalEndPoint!).Port);
        server._loop = server.AcceptLoopAsync(serve);
        return server;
    }

    private async Task AcceptLoopAsync(Func<Stream, CancellationToken, Task> serve)
    {
        while (!_stop.IsCancellationRequested)
        {
            Socket client;
            try
            {
                client = await _listener!.AcceptAsync(_stop.Token).ConfigureAwait(false);
            }
            catch (Exception) when (_stop.IsCancellationRequested)
            {
                return;
            }
            if (client.AddressFamily == AddressFamily.InterNetwork)
                client.NoDelay = true;
            _ = ServeSafeAsync(new NetworkStream(client, ownsSocket: true), serve);
        }
    }

    [SupportedOSPlatform("windows")]
    private async Task PipeLoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            var pipe = IpcPipeServer.Create(Fixtures.PluginName);
            try
            {
                await pipe.WaitForConnectionAsync(_stop.Token).ConfigureAwait(false);
            }
            catch (Exception) when (_stop.IsCancellationRequested)
            {
                await pipe.DisposeAsync().ConfigureAwait(false);
                return;
            }
            _ = ServeSafeAsync(pipe, static (stream, ct) => ServeFramesAsync(stream, ct));
        }
    }

    private async Task ServeSafeAsync(Stream stream, Func<Stream, CancellationToken, Task> serve)
    {
        try
        {
            await using (stream.ConfigureAwait(false))
                await serve(stream, _stop.Token).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Record(ex);
        }
    }

    private static async Task ServeFramesAsync(Stream stream, CancellationToken ct)
    {
        var reader = PipeReader.Create(stream, new StreamPipeReaderOptions(leaveOpen: true));
        while (true)
        {
            var result = await reader.ReadAsync(ct).ConfigureAwait(false);
            var buffer = result.Buffer;
            while (FrameReader.TryRead(ref buffer, out var frame))
            {
                using var response = FrameWriter.Encode(
                    FrameEncoding.Json,
                    FrameFlags.Response,
                    frame.Header.RequestId,
                    Fixtures.AllowBody
                );
                await stream.WriteAsync(response.Memory, ct).ConfigureAwait(false);
            }
            reader.AdvanceTo(buffer.Start, buffer.End);
            if (result.IsCompleted)
                return;
        }
    }

    private static async Task ServeHttpAsync(Stream stream, CancellationToken ct)
    {
        var buffer = new byte[8192];
        var filled = 0;
        var response = new byte[HttpHead.Length + Fixtures.AllowBody.Length];
        HttpHead.CopyTo(response, 0);
        Fixtures.AllowBody.CopyTo(response, HttpHead.Length);
        while (true)
        {
            int end;
            while ((end = buffer.AsSpan(0, filled).IndexOf("\r\n\r\n"u8)) < 0)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(filled), ct).ConfigureAwait(false);
                if (read == 0)
                    return;
                filled += read;
            }
            var bodyStart = end + 4;
            var total = bodyStart + ContentLength(buffer.AsSpan(0, end));
            while (filled < total)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(filled), ct).ConfigureAwait(false);
                if (read == 0)
                    return;
                filled += read;
            }
            await stream.WriteAsync(response, ct).ConfigureAwait(false);
            buffer.AsSpan(total, filled - total).CopyTo(buffer);
            filled -= total;
        }
    }

    private static int ContentLength(ReadOnlySpan<byte> head)
    {
        var text = Encoding.ASCII.GetString(head);
        var at = text.IndexOf("content-length:", StringComparison.OrdinalIgnoreCase);
        if (at < 0)
            return 0;
        var rest = text.AsSpan(at + "content-length:".Length);
        var lineEnd = rest.IndexOf('\r');
        return int.Parse(lineEnd < 0 ? rest.Trim() : rest[..lineEnd].Trim());
    }
}

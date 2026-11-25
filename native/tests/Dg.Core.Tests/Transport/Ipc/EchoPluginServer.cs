using System.Buffers;
using System.IO.Pipelines;
using System.Net.Sockets;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;

namespace Dg.Core.Tests.Transport.Ipc;

internal sealed class EchoPluginServer : IAsyncDisposable
{
    public const string SocketFile = "p.sock";

    private readonly Socket _listener = new(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
    private readonly CancellationTokenSource _stop = new();
    private readonly List<Socket> _clients = [];
    private readonly Task _accept;
    private readonly ServerFault _fault = new();
    private readonly bool _ownsDirectory;
    private int _accepted;

    public EchoPluginServer(UnixFileMode mode = UnixFileMode.UserRead | UnixFileMode.UserWrite, string? directory = null)
    {
        _ownsDirectory = directory is null;
        Directory = directory ?? System.IO.Directory.CreateTempSubdirectory("dgp").FullName;
        System.IO.Directory.CreateDirectory(Directory);
        SocketPath = Path.Combine(Directory, SocketFile);
        _listener.Bind(new UnixDomainSocketEndPoint(SocketPath));
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(SocketPath, mode);
        _listener.Listen(8);
        _accept = Task.Run(AcceptLoop);
    }

    public string Directory { get; }

    public string SocketPath { get; }

    public int Accepted => Volatile.Read(ref _accepted);

    public void DropClients()
    {
        lock (_clients)
        {
            foreach (var client in _clients)
                client.Dispose();
            _clients.Clear();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        _listener.Dispose();
        DropClients();
        try
        {
            await _accept;
        }
        catch (Exception ex)
        {
            _fault.Record(ex);
        }
        if (_ownsDirectory)
            System.IO.Directory.Delete(Directory, true);
        else
            File.Delete(SocketPath);
        _fault.ThrowIfFaulted();
    }

    private async Task AcceptLoop()
    {
        try
        {
            while (true)
            {
                var client = await _listener.AcceptAsync(_stop.Token);
                Interlocked.Increment(ref _accepted);
                lock (_clients)
                    _clients.Add(client);
                _ = Task.Run(() => Serve(client));
            }
        }
        catch (Exception ex)
        {
            _fault.Record(ex);
        }
    }

    private async Task Serve(Socket client)
    {
        try
        {
            var reader = PipeReader.Create(new NetworkStream(client));
            var writer = PipeWriter.Create(new NetworkStream(client));
            while (true)
            {
                var result = await reader.ReadAsync();
                var buffer = result.Buffer;
                while (FrameReader.TryRead(ref buffer, out var frame))
                {
                    var payload = frame.Payload.ToArray();
                    using var reply = FrameWriter.Encode(frame.Header.Encoding, FrameFlags.Response, frame.Header.RequestId, payload);
                    writer.Write(reply.Memory.Span);
                    await writer.FlushAsync();
                }
                reader.AdvanceTo(buffer.Start, buffer.End);
                if (result.IsCompleted)
                    return;
            }
        }
        catch (Exception ex)
        {
            _fault.Record(ex);
        }
    }
}

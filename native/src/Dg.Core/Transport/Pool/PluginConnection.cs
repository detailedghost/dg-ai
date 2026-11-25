using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Pipelines;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;

namespace Dg.Core.Transport.Pool;

public sealed class PluginConnection : IPluginTransport
{
    private readonly Stream _stream;
    private readonly PipeReader _reader;
    private readonly PipeWriter _writer;
    private readonly ConcurrentDictionary<uint, TaskCompletionSource<PluginResponse>> _pending = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly Task _readLoop;
    private Exception? _fault;
    private int _lastId;

    public PluginConnection(Stream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        _stream = stream;
        _reader = PipeReader.Create(stream, new StreamPipeReaderOptions(leaveOpen: true));
        _writer = PipeWriter.Create(stream, new StreamPipeWriterOptions(leaveOpen: true));
        _readLoop = Task.Run(ReadLoopAsync);
    }

    public bool IsUsable => _fault is null;

    public uint NextRequestId()
    {
        while (true)
        {
            var id = (uint)Interlocked.Increment(ref _lastId);
            if (id != 0)
                return id;
        }
    }

    public async ValueTask<PluginResponse> SendAsync(ReadOnlyMemory<byte> frame, CancellationToken ct)
    {
        if (_fault is { } fault)
            throw fault;
        var header = FrameHeader.Parse(frame.Span);
        if (frame.Length != PluginProtocol.HeaderBytes + (int)header.Length)
            throw FrameHeader.Error(
                "bad-frame",
                $"buffer is {frame.Length} bytes, header says {PluginProtocol.HeaderBytes + header.Length}",
                "pass exactly one encoded frame"
            );

        var waiter = new TaskCompletionSource<PluginResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(header.RequestId, waiter))
            throw FrameHeader.Error(
                "duplicate-request-id",
                $"request id {header.RequestId} is in flight",
                "take ids from NextRequestId"
            );
        try
        {
            await _writeLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                _writer.Write(frame.Span);
                await _writer.FlushAsync(ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Fail(ex);
                throw;
            }
            finally
            {
                _writeLock.Release();
            }
            return await waiter.Task.WaitAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _pending.TryRemove(header.RequestId, out _);
        }
    }

    public async ValueTask DisposeAsync()
    {
        Fail(new ObjectDisposedException(nameof(PluginConnection)));
        await _readLoop.ConfigureAwait(false);
        _writeLock.Dispose();
        _lifetime.Dispose();
    }

    private async Task ReadLoopAsync()
    {
        try
        {
            while (true)
            {
                var result = await _reader.ReadAsync(_lifetime.Token).ConfigureAwait(false);
                var buffer = result.Buffer;
                while (FrameReader.TryRead(ref buffer, out var frame))
                    Dispatch(in frame);
                _reader.AdvanceTo(buffer.Start, buffer.End);
                if (result.IsCompleted)
                {
                    Fail(new IOException("dg plugin: connection closed. Next: restart the plugin"));
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            Fail(ex);
        }
    }

    private void Dispatch(in Frame frame)
    {
        if ((frame.Header.Flags & FrameFlags.Response) == 0)
            return;
        if (_pending.TryRemove(frame.Header.RequestId, out var waiter))
            waiter.TrySetResult(new PluginResponse(frame.Header, frame.Payload.ToArray()));
    }

    private void Fail(Exception ex)
    {
        if (Interlocked.CompareExchange(ref _fault, ex, null) is not null)
            return;
        foreach (var (_, waiter) in _pending)
            waiter.TrySetException(ex);
        _lifetime.Cancel();
        _stream.Dispose();
    }
}

using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Pool;
using static Dg.Core.Tests.Transport.TransportTestSupport;

namespace Dg.Core.Tests.Transport;

public sealed class ConnectionLostTests
{
    private sealed class DisposedUnderWriteStream : Stream
    {
        private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() { }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await _closed.Task.WaitAsync(cancellationToken);
            return 0;
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new ObjectDisposedException("NetworkStream");

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) =>
            throw new ObjectDisposedException("NetworkStream");

        protected override void Dispose(bool disposing)
        {
            _closed.TrySetResult();
            base.Dispose(disposing);
        }
    }

    private static async Task<Exception?> SendAsync(PluginConnection connection)
    {
        using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, connection.NextRequestId(), HookMessage);
        return await Record.ExceptionAsync(async () => await connection.SendAsync(frame.Memory, CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_StreamDisposedUnderWrite_ThrowsIOException()
    {
        await using var connection = new PluginConnection(new DisposedUnderWriteStream());

        var error = await SendAsync(connection);

        Assert.IsAssignableFrom<IOException>(error);
        Assert.False(connection.IsUsable);
    }

    [Fact]
    public async Task SendAsync_AfterFault_ThrowsIOException()
    {
        await using var connection = new PluginConnection(new DisposedUnderWriteStream());
        await SendAsync(connection);

        var error = await SendAsync(connection);

        Assert.IsAssignableFrom<IOException>(error);
    }

    [Fact]
    public async Task SendAsync_AfterDispose_ThrowsIOException()
    {
        var connection = new PluginConnection(new DisposedUnderWriteStream());
        await connection.DisposeAsync();

        var error = await SendAsync(connection);

        Assert.IsAssignableFrom<IOException>(error);
    }

    [Fact]
    public async Task GetAsync_AfterConnectionFaulted_ReconnectsWithFreshConnection()
    {
        var connects = 0;
        await using var pool = new PluginConnectionPool(
            (_, _) =>
            {
                connects++;
                return ValueTask.FromResult<Stream>(new DisposedUnderWriteStream());
            }
        );
        var first = await pool.GetAsync("scanner", CancellationToken.None);
        Assert.IsAssignableFrom<IOException>(await SendAsync(first));

        var second = await pool.GetAsync("scanner", CancellationToken.None);

        Assert.NotSame(first, second);
        Assert.Equal(2, connects);
        Assert.True(second.IsUsable);
    }
}

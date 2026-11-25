using System.Buffers;

namespace Dg.Core.Transport.Framing;

public readonly struct PooledFrame : IDisposable
{
    private readonly byte[] _buffer;
    private readonly int _length;

    internal PooledFrame(byte[] buffer, int length)
    {
        _buffer = buffer;
        _length = length;
    }

    public ReadOnlyMemory<byte> Memory => _buffer.AsMemory(0, _length);

    public void Dispose()
    {
        if (_buffer is not null)
            ArrayPool<byte>.Shared.Return(_buffer);
    }
}

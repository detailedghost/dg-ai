using System.Buffers;
using System.Text;

namespace Dg.Core.Output;

public sealed class OutputWriter(Stream stream)
{
    private const int StackLimit = 512;

    public static OutputWriter Out { get; } = new(Console.OpenStandardOutput());

    public static OutputWriter Err { get; } = new(Console.OpenStandardError());

    public void Write(ReadOnlySpan<char> text) => Emit(text, newline: false);

    public void WriteLine(ReadOnlySpan<char> text) => Emit(text, newline: true);

    public void WriteLine() => stream.WriteByte((byte)'\n');

    private void Emit(ReadOnlySpan<char> text, bool newline)
    {
        var max = Encoding.UTF8.GetMaxByteCount(text.Length) + 1;
        byte[]? rented = null;
        Span<byte> buffer = max <= StackLimit ? stackalloc byte[StackLimit] : rented = ArrayPool<byte>.Shared.Rent(max);
        try
        {
            var length = Encoding.UTF8.GetBytes(text, buffer);
            if (newline)
                buffer[length++] = (byte)'\n';
            stream.Write(buffer[..length]);
        }
        finally
        {
            if (rented is not null)
                ArrayPool<byte>.Shared.Return(rented);
        }
    }

    public void Flush() => stream.Flush();
}

using System.Buffers;
using System.Text;

namespace Dg.Core.Output;

public sealed class OutputWriter(Stream stream)
{
    private const int StackLimit = 512;

    public static OutputWriter Out { get; } = new(Console.OpenStandardOutput());

    public static OutputWriter Err { get; } = new(Console.OpenStandardError());

    public void Write(ReadOnlySpan<char> text)
    {
        var max = Encoding.UTF8.GetMaxByteCount(text.Length);
        if (max <= StackLimit)
        {
            Span<byte> buffer = stackalloc byte[StackLimit];
            stream.Write(buffer[..Encoding.UTF8.GetBytes(text, buffer)]);
            return;
        }

        var rented = ArrayPool<byte>.Shared.Rent(max);
        try
        {
            stream.Write(rented, 0, Encoding.UTF8.GetBytes(text, rented));
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented);
        }
    }

    public void WriteLine(ReadOnlySpan<char> text)
    {
        Write(text);
        WriteLine();
    }

    public void WriteLine() => stream.WriteByte((byte)'\n');

    public void Flush() => stream.Flush();
}

using System.Text;
using Dg.Core.Output;

namespace Dg.Core.Tests;

public sealed class OutputWriterTests
{
    [Fact]
    public void WriteLine_MultibyteText_WritesUtf8WithLfAndNoBom()
    {
        using var stream = new MemoryStream();
        var writer = new OutputWriter(stream);

        writer.WriteLine("café ✓");
        writer.Flush();

        Assert.Equal("café ✓\n"u8.ToArray(), stream.ToArray());
    }

    [Fact]
    public void Write_TextLargerThanStackBuffer_RoundTrips()
    {
        using var stream = new MemoryStream();
        var writer = new OutputWriter(stream);
        var text = new string('é', 5000);

        writer.Write(text);
        writer.Flush();

        Assert.Equal(text, Encoding.UTF8.GetString(stream.ToArray()));
    }

    [Fact]
    public void WriteLine_NoArguments_WritesNewlineOnly()
    {
        using var stream = new MemoryStream();
        var writer = new OutputWriter(stream);

        writer.WriteLine();
        writer.Flush();

        Assert.Equal("\n"u8.ToArray(), stream.ToArray());
    }

    [Fact]
    public void WriteLine_Text_WritesTextAndNewlineInOneCall()
    {
        var stream = new CountingStream();
        var writer = new OutputWriter(stream);

        writer.WriteLine("hook output");

        Assert.Equal(1, stream.Writes);
        Assert.Equal("hook output\n", Encoding.UTF8.GetString(stream.Bytes.ToArray()));
    }

    private sealed class CountingStream : MemoryStream
    {
        public int Writes { get; private set; }

        public ReadOnlySpan<byte> Bytes => GetBuffer().AsSpan(0, (int)Length);

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            Writes++;
            base.Write(buffer);
        }

        public override void WriteByte(byte value)
        {
            Writes++;
            base.WriteByte(value);
        }
    }
}

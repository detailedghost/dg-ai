using System.Buffers;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;

namespace Dg.Core.Tests.Transport.Framing;

public sealed class FrameReaderTests
{
    public static TheoryData<string> Names() => FrameFixtures.ValidNames();

    [Theory]
    [MemberData(nameof(Names))]
    public void TryRead_FixtureFrame_ParsesHeaderAndPayload(string name)
    {
        var fixture = FrameFixtures.Valid().Single(f => f.Name == name);
        var buffer = new ReadOnlySequence<byte>(fixture.Wire);

        var read = FrameReader.TryRead(ref buffer, out var frame);

        Assert.True(read);
        Assert.Equal(fixture.RequestId, frame.Header.RequestId);
        Assert.Equal(fixture.Encoding, (byte)frame.Header.Encoding);
        Assert.Equal(fixture.Flags, (ushort)frame.Header.Flags);
        Assert.Equal(fixture.Payload, frame.Payload.ToArray());
        Assert.True(buffer.IsEmpty);
    }

    [Fact]
    public void TryRead_SplitAcrossSegments_ParsesFrame()
    {
        var fixture = FrameFixtures.Valid().Single(f => f.Name == "hello-request");
        var buffer = Split(fixture.Wire, 5, 13, 40);

        var read = FrameReader.TryRead(ref buffer, out var frame);

        Assert.True(read);
        Assert.Equal(fixture.Payload, frame.Payload.ToArray());
    }

    [Fact]
    public void TryRead_TwoFramesInOneBuffer_ReadsBothInOrder()
    {
        var all = FrameFixtures.Valid();
        var wire = all[0].Wire.Concat(all[1].Wire).ToArray();
        var buffer = new ReadOnlySequence<byte>(wire);

        Assert.True(FrameReader.TryRead(ref buffer, out var first));
        Assert.True(FrameReader.TryRead(ref buffer, out var second));
        Assert.False(FrameReader.TryRead(ref buffer, out _));

        Assert.Equal(all[0].RequestId, first.Header.RequestId);
        Assert.Equal(all[1].RequestId, second.Header.RequestId);
    }

    [Fact]
    public void TryRead_PartialHeaderOrPayload_ReturnsFalseAndKeepsBuffer()
    {
        var wire = FrameFixtures.Valid()[1].Wire;
        foreach (var cut in new[] { 0, 5, 11, 12, wire.Length - 1 })
        {
            var buffer = new ReadOnlySequence<byte>(wire.AsMemory(0, cut));

            Assert.False(FrameReader.TryRead(ref buffer, out _));
            Assert.Equal(cut, buffer.Length);
        }
    }

    [Fact]
    public void TryRead_OversizeHeaderWithoutPayload_ThrowsBeforePayloadArrives()
    {
        var invalid = FrameFixtures.Invalid().Single(f => f.Name == "oversize");
        var buffer = new ReadOnlySequence<byte>(invalid.Wire);

        var ex = Assert.Throws<PluginContractException>(() => FrameReader.TryRead(ref buffer, out _));

        Assert.Equal("oversize", ex.Code);
        Assert.Equal(PluginProtocol.HeaderBytes, invalid.Wire.Length);
    }

    [Theory]
    [InlineData("bad-version")]
    [InlineData("bad-encoding")]
    [InlineData("reserved-flags")]
    public void TryRead_InvalidHeaderFixture_ThrowsFixtureError(string name)
    {
        var invalid = FrameFixtures.Invalid().Single(f => f.Name == name);
        var buffer = new ReadOnlySequence<byte>(invalid.Wire);

        var ex = Assert.Throws<PluginContractException>(() => FrameReader.TryRead(ref buffer, out _));

        Assert.Equal(invalid.Error, ex.Code);
    }

    [Fact]
    public void TryRead_TrailingBytes_LeavesThemInBuffer()
    {
        var invalid = FrameFixtures.Invalid().Single(f => f.Name == "trailing-bytes");
        var buffer = new ReadOnlySequence<byte>(invalid.Wire);

        Assert.True(FrameReader.TryRead(ref buffer, out _));

        Assert.Equal(3, buffer.Length);
    }

    [Fact]
    public void TryRead_HotPath_AllocatesNothing()
    {
        var single = new ReadOnlySequence<byte>(FrameFixtures.Valid()[1].Wire);
        var segmented = Split(FrameFixtures.Valid()[1].Wire, 7, 30);
        for (var i = 0; i < 100; i++)
        {
            var warm = single;
            FrameReader.TryRead(ref warm, out _);
            warm = segmented;
            FrameReader.TryRead(ref warm, out _);
        }

        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 10_000; i++)
        {
            var a = single;
            FrameReader.TryRead(ref a, out _);
            var b = segmented;
            FrameReader.TryRead(ref b, out _);
        }
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.Equal(0, allocated);
    }

    private static ReadOnlySequence<byte> Split(byte[] wire, params int[] cuts)
    {
        Segment? first = null,
            last = null;
        var start = 0;
        foreach (var end in cuts.Append(wire.Length))
        {
            var next = new Segment(wire.AsMemory(start, end - start));
            if (last is null)
                first = next;
            else
                last.Link(next);
            last = next;
            start = end;
        }
        return new ReadOnlySequence<byte>(first!, 0, last!, last!.Memory.Length);
    }

    private sealed class Segment : ReadOnlySequenceSegment<byte>
    {
        public Segment(ReadOnlyMemory<byte> memory) => Memory = memory;

        public void Link(Segment next)
        {
            next.RunningIndex = RunningIndex + Memory.Length;
            Next = next;
        }
    }
}

using System.Text;
using Dg.Hooks.Defs.Pr;
using Dg.Hooks.Defs.Text;
using Dg.Hooks.Engine;
using Dg.Hooks.Shared;

namespace Dg.Hooks.Tests;

[Collection(AllocationCollection.Name)]
public sealed class HookAllocationTests
{
    private sealed class CapturingHook : IHook
    {
        public string Id => "capture";

        public List<HookEvent> Seen { get; } = [];

        public ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
        {
            Seen.Add(ev);
            return ValueTask.FromResult(0);
        }
    }

    private sealed class TrickleStream(byte[] data, int chunk) : Stream
    {
        private int _position;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => data.Length;

        public override long Position
        {
            get => _position;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            var take = Math.Min(Math.Min(chunk, buffer.Length), data.Length - _position);
            data.AsSpan(_position, take).CopyTo(buffer);
            _position += take;
            return take;
        }

        public override void Flush() { }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static byte[] WriteEvent(int contentChars) =>
        Encoding.UTF8.GetBytes(
            $$"""{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"a.md","content":"{{new string('x', contentChars)}}"},"cwd":"."}"""
        );

    [Fact]
    public void For_SameLocale_ReturnsTheCachedTable()
    {
        Assert.Same(SpellingTable.For("en-US"), SpellingTable.For("en-US"));
        Assert.Same(SpellingTable.For("en-GB"), SpellingTable.For("en-GB"));
        Assert.NotSame(SpellingTable.For("en-US"), SpellingTable.For("en-GB"));
    }

    [Fact]
    public void For_RepeatedCalls_StaysUnderBudget()
    {
        var bytes = AllocationProbe.BytesPerOp(() => SpellingTable.For("en-US"));

        Assert.True(bytes <= 64, $"SpellingTable.For allocated {bytes} B/op");
    }

    [Fact]
    public void Trim_NothingToTrim_ReturnsTheSameInstance()
    {
        var text = "hello world";

        Assert.Same(text, JsText.Trim(text));
    }

    [Fact]
    public void Trim_SurroundingWhitespace_RemovesIt() => Assert.Equal("hello", JsText.Trim("  hello\t"));

    [Fact]
    public void Trim_OnlyWhitespace_ReturnsEmpty() => Assert.Equal("", JsText.Trim(" \n "));

    [Fact]
    public async Task RunAsync_StdinInTrickleChunks_ReadsTheWholeEvent()
    {
        var hook = new CapturingHook();
        var engine = new HookEngine([hook], TextWriter.Null, TextWriter.Null);
        var data = WriteEvent(70_000);

        await engine.RunAsync("capture", [], new TrickleStream(data, 5_000), CancellationToken.None);

        Assert.Equal(70_000, Assert.Single(hook.Seen).Content!.Length);
    }

    [Fact]
    public void RunAsync_LargeStdin_ReadsWithoutIntermediateCopies()
    {
        var engine = new HookEngine([new CapturingHook()], TextWriter.Null, TextWriter.Null);
        using MemoryStream stdin = new(WriteEvent(100_000));

        var bytes = AllocationProbe.TotalBytesPerOp(
            () =>
            {
                stdin.Position = 0;
                engine.RunAsync("capture", [], stdin, CancellationToken.None).AsTask().GetAwaiter().GetResult();
            },
            100
        );

        Assert.True(bytes <= 250_000, $"HookEngine.RunAsync allocated {bytes} B/op for a 100 KB event");
    }

    [Fact]
    public void Scan_TypicalBody_AllocatesLittle()
    {
        var body =
            "This change fixes the bug in the parser. It adds a test for the new case.\n\n- first bullet point here\n- second bullet\n\n## Notes\n\n"
            + string.Join('\n', Enumerable.Repeat("A line of prose that keeps going with several words in it.", 30));

        var bytes = AllocationProbe.BytesPerOp(() => PrBodyScanner.Scan(body, 40), 100);

        Assert.True(bytes <= 32_000, $"PrBodyScanner.Scan allocated {bytes} B/op");
    }

    [Fact]
    public void Scan_EmptyBody_ReportsNothing() => Assert.Empty(PrBodyScanner.Scan("", 40));

    [Fact]
    public void Scan_CrLfBodyWithFiller_ReportsFillerOnItsLine()
    {
        var findings = PrBodyScanner.Scan("Fix the parser today.\r\n\r\nThis is a SEAMLESS upgrade for users.\r\n", 40);

        var finding = Assert.Single(findings);
        Assert.Equal(3, finding.Line);
        Assert.Contains("seamless", finding.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RunAsync_ChildPrintsMoreThanOneChunk_ReturnsAllOutput()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "needs a POSIX shell");

        var result = await HookProcess.RunAsync(
            HookEnvironment.Process().Values,
            ["sh", "-c", "head -c 40000 /dev/zero | tr '\\0' x"],
            null,
            CancellationToken.None
        );

        Assert.Equal(0, result.Status);
        Assert.Equal(40_000, result.Stdout.Length);
        Assert.False(result.Truncated);
    }

    [Fact]
    public void RunAsync_ShortChild_DoesNotAllocateTheReadBuffersPerCall()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "needs a POSIX shell");
        var env = HookEnvironment.Process().Values;

        var bytes = AllocationProbe.TotalBytesPerOp(
            () => HookProcess.RunAsync(env, ["true"], null, CancellationToken.None).GetAwaiter().GetResult(),
            20
        );

        Assert.True(bytes <= 90_000, $"HookProcess.RunAsync allocated {bytes} B/op");
    }
}

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class AllocationCollection
{
    public const string Name = "allocation";
}

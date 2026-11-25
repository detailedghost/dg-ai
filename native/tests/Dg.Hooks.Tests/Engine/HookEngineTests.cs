using System.Text;
using Dg.Hooks.Engine;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Hooks.Tests.Engine;

public sealed class HookEngineTests
{
    private sealed class RecordingHook(string id, params int[] codes) : IHook
    {
        private int _next;

        public string Id => id;

        public List<HookEvent> Seen { get; } = [];

        public ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
        {
            Seen.Add(ev);
            return ValueTask.FromResult(codes[Math.Min(_next++, codes.Length - 1)]);
        }
    }

    private sealed class ThrowingHook : IHook
    {
        public string Id => "boom";

        public ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct) =>
            throw new InvalidOperationException("kaput");
    }

    private sealed class ThrowOnReadStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush() { }

        public override int Read(byte[] buffer, int offset, int count) =>
            throw new InvalidOperationException("stdin was read");

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;

    private sealed class FakeProvider(IReadOnlyList<IHook> hooks) : IServiceProvider
    {
        public object? GetService(Type serviceType) =>
            serviceType == typeof(IEnumerable<IHook>) ? hooks : null;
    }

    private static MemoryStream Stdin(string json) => new(Encoding.UTF8.GetBytes(json));

    [Fact]
    public async Task RunAsync_UnknownId_ReturnsZeroAndPrintsNothing()
    {
        var error = new StringWriter();
        var engine = new HookEngine([new RecordingHook("known", 0)], error);

        var code = await engine.RunAsync("nope", [], Stdin("{}"), CancellationToken.None);

        Assert.Equal(0, code);
        Assert.Equal("", error.ToString());
    }

    [Fact]
    public async Task RunAsync_UnknownId_DoesNotReadStdin()
    {
        var engine = new HookEngine([], new StringWriter());

        var code = await engine.RunAsync("nope", [], new ThrowOnReadStream(), CancellationToken.None);

        Assert.Equal(0, code);
    }

    [Fact]
    public async Task RunAsync_KnownId_PassesParsedEventAndArgsToHook()
    {
        var hook = new RecordingHook("spelling", 0);
        var engine = new HookEngine([hook], new StringWriter());

        await engine.RunAsync(
            "spelling",
            ["--now"],
            Stdin("""{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"a.md"}}"""),
            CancellationToken.None
        );

        var seen = Assert.Single(hook.Seen);
        Assert.Equal("Edit", seen.ToolName);
        Assert.Equal("a.md", seen.FilePath);
        Assert.Equal(["--now"], seen.Args);
    }

    [Fact]
    public async Task RunAsync_NullStdin_RunsHookWithEmptyEvent()
    {
        var hook = new RecordingHook("strip-ai-coauthors", 0);
        var engine = new HookEngine([hook], new StringWriter());

        await engine.RunAsync("strip-ai-coauthors", ["msg.txt"], null, CancellationToken.None);

        var seen = Assert.Single(hook.Seen);
        Assert.Null(seen.ToolName);
        Assert.Equal(["msg.txt"], seen.Args);
    }

    [Fact]
    public async Task RunAsync_InvalidJson_RunsHookWithEmptyEvent()
    {
        var hook = new RecordingHook("format", 0);
        var engine = new HookEngine([hook], new StringWriter());

        await engine.RunAsync("format", [], Stdin("garbage"), CancellationToken.None);

        Assert.Null(Assert.Single(hook.Seen).ToolName);
    }

    [Fact]
    public async Task RunAsync_HookReturnsCode_ReturnsIt()
    {
        var engine = new HookEngine([new RecordingHook("pr-prose", 2)], new StringWriter());

        var code = await engine.RunAsync("pr-prose", [], Stdin("{}"), CancellationToken.None);

        Assert.Equal(2, code);
    }

    [Fact]
    public async Task RunAsync_ApplyPatchWithTwoFiles_RunsHookPerFileAndTwoWins()
    {
        var hook = new RecordingHook("spelling", 1, 2, 0);
        var engine = new HookEngine([hook], new StringWriter());
        var json = """{"tool_name":"apply_patch","cwd":"/w","tool_input":{"command":"*** Add File: a.md\n+x\n*** Add File: b.md\n+y\n*** Add File: c.md\n+z"}}""";

        var code = await engine.RunAsync("spelling", [], Stdin(json), CancellationToken.None);

        Assert.Equal(2, code);
        Assert.Equal(["/w/a.md", "/w/b.md", "/w/c.md"], hook.Seen.Select(e => e.FilePath));
    }

    [Fact]
    public async Task RunAsync_ApplyPatchWithoutFiles_RunsNothingAndReturnsZero()
    {
        var hook = new RecordingHook("spelling", 1);
        var engine = new HookEngine([hook], new StringWriter());

        var code = await engine.RunAsync(
            "spelling",
            [],
            Stdin("""{"tool_name":"apply_patch","tool_input":{"command":"*** Delete File: a.md"}}"""),
            CancellationToken.None
        );

        Assert.Equal(0, code);
        Assert.Empty(hook.Seen);
    }

    [Fact]
    public async Task RunAsync_MixedCodes_ReturnsHighest()
    {
        var hook = new RecordingHook("spelling", 0, 1);
        var engine = new HookEngine([hook], new StringWriter());
        var json = """{"tool_name":"apply_patch","tool_input":{"command":"*** Add File: a.md\n+x\n*** Add File: b.md\n+y"}}""";

        Assert.Equal(1, await engine.RunAsync("spelling", [], Stdin(json), CancellationToken.None));
    }

    [Fact]
    public async Task RunAsync_HookThrows_ReturnsOneAndNamesHookOnStderr()
    {
        var error = new StringWriter();
        var engine = new HookEngine([new ThrowingHook()], error);

        var code = await engine.RunAsync("boom", [], Stdin("{}"), CancellationToken.None);

        Assert.Equal(1, code);
        Assert.Equal("hooks run boom: kaput\n", error.ToString().ReplaceLineEndings("\n"));
    }

    [Fact]
    public async Task RunAsync_Canceled_Propagates()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        var engine = new HookEngine([new RecordingHook("format", 0)], new StringWriter());

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await engine.RunAsync("format", [], Stdin("{}"), cts.Token)
        );
    }

    [Fact]
    public void AddHooks_RegistersEngineBuiltFromRegisteredHooks()
    {
        var services = new FakeServices();
        var hook = new RecordingHook("format", 0);

        services.AddHooks();

        var descriptor = Assert.Single(services, d => d.ServiceType == typeof(HookEngine));
        var engine = Assert.IsType<HookEngine>(descriptor.ImplementationFactory!(new FakeProvider([hook])));
        Assert.True(engine.Has("format"));
        Assert.False(engine.Has("spelling"));
    }
}

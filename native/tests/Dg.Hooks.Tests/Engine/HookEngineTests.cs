using System.Runtime.Versioning;
using System.Text;
using Dg.Hooks.Defs.Pr;
using Dg.Hooks.Defs.Repo;
using Dg.Hooks.Engine;
using Dg.Hooks.Shared;
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

    private sealed class NoopSpawner : IDetachedSpawner
    {
        public void Spawn(IReadOnlyList<string> argv) { }
    }

    private sealed class ContextHook(string eventName, TextWriter direct) : IHook
    {
        public string Id => "ctx";

        public ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
        {
            HookJson.EmitContext(ev, eventName, $"note {Path.GetFileName(ev.FilePath)}", direct.Write);
            return ValueTask.FromResult(0);
        }
    }

    private sealed class StdinFreeHook(bool usesStdin) : IHook
    {
        public string Id => "free";

        public List<HookEvent> Seen { get; } = [];

        public bool UsesStdin(string[] args) => usesStdin;

        public ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
        {
            Seen.Add(ev);
            return ValueTask.FromResult(0);
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
    public async Task AddHooks_RegistersEngineBuiltFromRegisteredHooks()
    {
        var services = new FakeServices();
        var hook = new RecordingHook("format", 0);

        services.AddHooks();

        var descriptor = Assert.Single(services, d => d.ServiceType == typeof(HookEngine));
        var engine = Assert.IsType<HookEngine>(descriptor.ImplementationFactory!(new FakeProvider([hook])));
        await engine.RunAsync("format", [], Stdin("{}"), CancellationToken.None);
        Assert.Single(hook.Seen);
    }

    [Fact]
    public async Task RunAsync_ApplyPatchContexts_AreJoinedIntoOneJson()
    {
        var output = new StringWriter();
        var direct = new StringWriter();
        var engine = new HookEngine([new ContextHook("PostToolUse", direct)], new StringWriter(), output);
        var json = """{"tool_name":"apply_patch","cwd":"/w","tool_input":{"command":"*** Add File: a.md\n+x\n*** Add File: b.md\n+y"}}""";

        await engine.RunAsync("ctx", [], Stdin(json), CancellationToken.None);

        Assert.Equal(
            """{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"note a.md\nnote b.md"}}""",
            output.ToString()
        );
        Assert.Equal("", direct.ToString());
    }

    [Fact]
    public async Task RunAsync_SingleEventContext_WritesOneJson()
    {
        var output = new StringWriter();
        var engine = new HookEngine([new ContextHook("PreToolUse", new StringWriter())], new StringWriter(), output);

        await engine.RunAsync("ctx", [], Stdin("""{"tool_name":"Edit","tool_input":{"file_path":"/w/a.md"}}"""), CancellationToken.None);

        Assert.Equal(
            """{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"note a.md"}}""",
            output.ToString()
        );
    }

    [Fact]
    public void EmitContext_WithoutSink_WritesDirectly()
    {
        var direct = new StringWriter();

        HookJson.EmitContext(default, "PostToolUse", "hi", direct.Write);

        Assert.Equal(
            """{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"hi"}}""",
            direct.ToString()
        );
    }

    [Fact]
    public async Task RunAsync_HookThatSkipsStdin_DoesNotReadIt()
    {
        var hook = new StdinFreeHook(usesStdin: false);
        var engine = new HookEngine([hook], new StringWriter());

        var code = await engine.RunAsync("free", ["--now"], new ThrowOnReadStream(), CancellationToken.None);

        Assert.Equal(0, code);
        Assert.Equal(["--now"], Assert.Single(hook.Seen).Args);
    }

    [Fact]
    public async Task RunAsync_StdinIsTerminal_DoesNotReadIt()
    {
        var hook = new StdinFreeHook(usesStdin: true);
        var engine = new HookEngine([hook], new StringWriter(), stdinIsTerminal: () => true);

        var code = await engine.RunAsync("free", [], new ThrowOnReadStream(), CancellationToken.None);

        Assert.Equal(0, code);
        Assert.Null(Assert.Single(hook.Seen).ToolName);
    }

    [Fact]
    public void UsesStdin_CommitMsgHook_IsFalse()
    {
        var strip = new StripAiCoauthorsHook(new PrHookHost());

        Assert.False(strip.UsesStdin(["msg"]));
        Assert.False(strip.UsesStdin([]));
    }

    [Theory]
    [InlineData(new string[] { "--now" }, false)]
    [InlineData(new string[] { "--now", "--dry-run" }, false)]
    [InlineData(new string[] { "--dry-run" }, false)]
    [InlineData(new string[] { }, true)]
    public void UsesStdin_DailyPrune_DependsOnFlags(string[] args, bool expected)
    {
        var hook = new DailyPruneHook(
            _ => null,
            "/h",
            new ProcessCommandRunner(),
            new NoopSpawner(),
            TimeProvider.System,
            TextWriter.Null,
            TextWriter.Null
        );

        Assert.Equal(expected, hook.UsesStdin(args));
    }

    [Fact]
    [SupportedOSPlatform("linux")]
    [SupportedOSPlatform("macos")]
    public async Task RunAsync_UnsafeScratchDirectory_FailsBeforeRunningHook()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "unix file modes");
        using var temp = TempRoot.Create();
        File.SetUnixFileMode(temp.Path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.OtherWrite);
        Dictionary<string, string?> env = new() { ["AI_SCRATCH_DIR"] = temp.Path, ["AI_STATE_DIR"] = Path.Combine(temp.Path, "state") };
        var hook = new RecordingHook("format", 0);
        var error = new StringWriter();
        var engine = new HookEngine(
            [hook],
            error,
            directories: new HookDirectories(name => env.GetValueOrDefault(name), temp.Path)
        );

        var code = await engine.RunAsync("format", [], Stdin("{}"), CancellationToken.None);

        Assert.Equal(1, code);
        Assert.Empty(hook.Seen);
        Assert.StartsWith("hooks run format: unsafe scratch/state directory:", error.ToString());
    }

    [Fact]
    public async Task RunAsync_SafeDirectories_CreatesHooksChildrenAndRunsHook()
    {
        using var temp = TempRoot.Create();
        Dictionary<string, string?> env = new()
        {
            ["AI_SCRATCH_DIR"] = Path.Combine(temp.Path, "scratch"),
            ["AI_STATE_DIR"] = Path.Combine(temp.Path, "state"),
        };
        var hook = new RecordingHook("format", 0);
        var engine = new HookEngine(
            [hook],
            new StringWriter(),
            directories: new HookDirectories(name => env.GetValueOrDefault(name), temp.Path)
        );

        await engine.RunAsync("format", [], Stdin("{}"), CancellationToken.None);

        Assert.Single(hook.Seen);
        Assert.True(Directory.Exists(Path.Combine(temp.Path, "scratch", "hooks")));
        Assert.True(Directory.Exists(Path.Combine(temp.Path, "state", "hooks")));
    }
}

using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Tests.Plugins.Runtime;
using Dg.Core.Tests.Transport.Http;
using Dg.Core.Tests.Transport.Ipc;
using Dg.Core.Tests.Transport.Tcp;

namespace Dg.Core.Tests.Leaks;

[Collection(LeakCollection.Name)]
public sealed class PluginHostLeakTests
{
    private const string Enabled = "[plugins.scanner]\nenabled = true\n";
    private const int MaxBytesPerCall = 64;

    private static string Manifest(string transport, string endpoint) =>
        $"""
        name = "scanner"
        version = "1.0.0"
        kind = "hook"
        transport = "{transport}"
        endpoint = "{endpoint}"
        [entry]
        command = "scanner"
        """;

    private static void AssertFlat(LeakReport report)
    {
        Assert.True(
            report.BytesPerIteration < MaxBytesPerCall,
            $"heap grows {report.BytesPerIteration:F1} bytes per call ({report.FirstBatchBytes} to {report.LastBatchBytes})"
        );
        Assert.True(report.OpenFilesGrowth <= 16, $"{report.OpenFilesGrowth} more open files after the run");
        Assert.True(report.ThreadGrowth <= 4, $"{report.ThreadGrowth} more pool threads after the run");
    }

    [Fact]
    public async Task InvokeAsync_ManyCallsOverIpc_KeepsHeapFilesAndThreadsFlat()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Windows dials a named pipe, and the echo server listens on a Unix socket");
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", Manifest("ipc", EchoPluginServer.SocketFile), approved: true);
        var host = fixture.Host(Enabled);
        var message = RuntimeFixture.HookMessage();

        var report = await LeakMeter.MeasureAsync(
            async () => await host.InvokeAsync("scanner", message, CancellationToken.None),
            batches: 5,
            perBatch: 1_500
        );

        AssertFlat(report);
    }

    [Fact]
    public async Task InvokeAsync_TreeTouchedEveryCall_RehashesAndKeepsHeapFilesAndThreadsFlat()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Windows dials a named pipe, and the echo server listens on a Unix socket");
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", Manifest("ipc", EchoPluginServer.SocketFile), approved: true);
        var host = fixture.Host(Enabled);
        var message = RuntimeFixture.HookMessage();
        var body = Path.Combine(fixture.Folder("scanner"), "src", "main.txt");
        var touched = DateTime.UtcNow;

        var report = await LeakMeter.MeasureAsync(
            async () =>
            {
                File.SetLastWriteTimeUtc(body, touched = touched.AddSeconds(1));
                await host.InvokeAsync("scanner", message, CancellationToken.None);
            },
            batches: 4,
            perBatch: 400,
            warmup: 50
        );

        AssertFlat(report);
        var folder = fixture.Folder("scanner");
        var src = Path.Combine(folder, "src");
        var record = PluginApprovalRecord.Read(folder)!;
        Assert.True(
            PluginStatCache.Attests(
                folder,
                ApprovalFixture.Key,
                record.TreeSha256,
                PluginStatCache.Snapshot(src),
                DateTimeOffset.UtcNow
            )
        );
    }

    [Fact]
    public async Task InvokeAsync_ManyCallsOverTcp_KeepsHeapFilesAndThreadsFlat()
    {
        await using var server = new TcpPluginServer();
        await using var fixture = new RuntimeFixture();
        fixture.Install("scanner", Manifest("tcp", $"127.0.0.1:{server.Port}"), approved: true);
        var host = fixture.Host(Enabled);
        var message = RuntimeFixture.HookMessage();

        var report = await LeakMeter.MeasureAsync(
            async () => await host.InvokeAsync("scanner", message, CancellationToken.None),
            batches: 5,
            perBatch: 1_500
        );

        AssertFlat(report);
    }

    [Fact]
    public async Task InvokeAsync_ManyCallsOverHttp_KeepsHeapFilesAndThreadsFlat()
    {
        await using var server = new LoopbackServer(_ => new Reply(Body: """{"decision":"allow"}"""), record: false);
        await using var fixture = new RuntimeFixture();
        fixture.Install("scanner", Manifest("http", server.Endpoint), approved: true);
        fixture.SetCredential("plugin-scanner-token", "tok");
        var host = fixture.Host(Enabled);
        var message = RuntimeFixture.HookMessage();

        var report = await LeakMeter.MeasureAsync(
            async () => await host.InvokeAsync("scanner", message, CancellationToken.None),
            batches: 5,
            perBatch: 1_500
        );

        AssertFlat(report);
    }

    [Fact]
    public async Task InvokeAsync_PluginRestartsEveryCall_KeepsHeapFilesAndThreadsFlat()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Windows dials a named pipe, and the echo server listens on a Unix socket");
        await using var fixture = new RuntimeFixture();
        await using var server = new EchoPluginServer(directory: fixture.Folder("scanner"));
        fixture.Install("scanner", Manifest("ipc", EchoPluginServer.SocketFile), approved: true);
        var host = fixture.Host(Enabled);
        var message = RuntimeFixture.HookMessage();

        const int batches = 4;
        const int perBatch = 400;
        const int warmup = 500;
        var successes = 0;

        var report = await LeakMeter.MeasureAsync(
            async () =>
            {
                try
                {
                    await host.InvokeAsync("scanner", message, CancellationToken.None);
                    successes++;
                }
                catch (IOException) { }
                server.DropClients();
                await Task.Delay(1);
            },
            batches,
            perBatch,
            warmup
        );

        Assert.True(
            successes >= (batches * perBatch + warmup) / 2,
            $"only {successes} of {batches * perBatch + warmup} calls succeeded"
        );
        AssertFlat(report);
    }
}

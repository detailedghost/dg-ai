using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Http;
using Dg.Core.Transport.Ipc;
using Dg.Core.Transport.Pool;

namespace Dg.Bench;

internal static class Runner
{
    private const int Warmup = 300;
    private const int Samples = 2000;
    private const int FreshWarmup = 3;
    private const int FreshSamples = 40;

    public static async Task<BenchReport> RunAsync(CancellationToken ct)
    {
        var cases = new List<CaseResult>
        {
            await BuiltInAsync().ConfigureAwait(false),
            await IpcWarmAsync(ct).ConfigureAwait(false),
            await TcpWarmAsync(ct).ConfigureAwait(false),
            await HttpWarmAsync(ct).ConfigureAwait(false),
            await FreshAsync("ipc-fresh-process", "ipc", ct).ConfigureAwait(false),
            await FreshAsync("http-fresh-process", "http", ct).ConfigureAwait(false),
            await Stats.MeasureAsync("json-encode", Warmup, Samples, static () => { Codecs.JsonEncode(); return ValueTask.CompletedTask; }).ConfigureAwait(false),
            await JsonDecodeAsync().ConfigureAwait(false),
            await Stats.MeasureAsync("msgpack-encode", Warmup, Samples, static () => { Codecs.PackEncode(); return ValueTask.CompletedTask; }).ConfigureAwait(false),
            await Stats.MeasureAsync("msgpack-decode", Warmup, Samples, static () => { Codecs.PackDecode(); return ValueTask.CompletedTask; }).ConfigureAwait(false),
        };
        return new BenchReport(
            RuntimeInformation.RuntimeIdentifier,
            Find(cases, "ipc-warm").P50Ms,
            Find(cases, "http-warm").P50Ms,
            Find(cases, "ipc-fresh-process").P50Ms,
            Find(cases, "http-fresh-process").P50Ms,
            cases
        );
    }

    private static CaseResult Find(List<CaseResult> cases, string name) => cases.Find(c => c.Name == name)!;

    private static Task<CaseResult> BuiltInAsync() =>
        Stats.MeasureAsync(
            "built-in",
            Warmup,
            Samples,
            static () =>
            {
                Codecs.JsonDecode(Fixtures.EnvelopePayload);
                return ValueTask.CompletedTask;
            }
        );

    private static Task<CaseResult> JsonDecodeAsync()
    {
        var payload = Codecs.JsonEncode();
        return Stats.MeasureAsync("json-decode", Warmup, Samples, () => { Codecs.JsonDecode(payload); return ValueTask.CompletedTask; });
    }

    private static async Task<CaseResult> IpcWarmAsync(CancellationToken ct)
    {
        var socketPath = Path.Combine(Path.GetTempPath(), $"dgb-{Environment.ProcessId}.sock");
        await using var server = EchoServer.StartIpc(socketPath);
        var stream = await new IpcConnector(new FixedSocketResolver(socketPath))
            .ConnectAsync(Fixtures.PluginName, ct)
            .ConfigureAwait(false);
        return await MeasureConnectionAsync("ipc-warm", new PluginConnection(stream), ct).ConfigureAwait(false);
    }

    private static async Task<CaseResult> TcpWarmAsync(CancellationToken ct)
    {
        await using var server = EchoServer.StartTcp();
        var client = new TcpClient { NoDelay = true };
        await client.ConnectAsync(System.Net.IPAddress.Loopback, server.Port, ct).ConfigureAwait(false);
        return await MeasureConnectionAsync("tcp-warm", new PluginConnection(client.GetStream()), ct).ConfigureAwait(false);
    }

    private static async Task<CaseResult> MeasureConnectionAsync(string name, PluginConnection connection, CancellationToken ct)
    {
        await using (connection.ConfigureAwait(false))
        {
            return await Stats.MeasureAsync(
                    name,
                    Warmup,
                    Samples,
                    async () =>
                    {
                        using var frame = FrameWriter.Encode(
                            FrameEncoding.Json,
                            FrameFlags.None,
                            connection.NextRequestId(),
                            Fixtures.EnvelopePayload
                        );
                        await connection.SendAsync(frame.Memory, ct).ConfigureAwait(false);
                    }
                )
                .ConfigureAwait(false);
        }
    }

    private static async Task<CaseResult> HttpWarmAsync(CancellationToken ct)
    {
        await using var server = EchoServer.StartHttp();
        await using var transport = new HttpTransport(Fixtures.HttpManifest(server.Port), false, new FixedTokenProvider());
        return await Stats.MeasureAsync(
                "http-warm",
                Warmup,
                Samples,
                async () =>
                {
                    using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, 1, Fixtures.EnvelopePayload);
                    await transport.SendAsync(frame.Memory, ct).ConfigureAwait(false);
                }
            )
            .ConfigureAwait(false);
    }

    private static async Task<CaseResult> FreshAsync(string name, string transport, CancellationToken ct)
    {
        var socketPath = Path.Combine(Path.GetTempPath(), $"dgb-fresh-{Environment.ProcessId}.sock");
        await using var server = transport == "ipc" ? EchoServer.StartIpc(socketPath) : EchoServer.StartHttp();
        var endpoint = transport == "ipc" ? socketPath : server.Port.ToString();
        var exe = Environment.ProcessPath!;
        return await Stats.MeasureAsync(
                name,
                FreshWarmup,
                FreshSamples,
                async () =>
                {
                    using var process = Process.Start(new ProcessStartInfo(exe, ["--child", transport, endpoint]) { UseShellExecute = false })!;
                    await process.WaitForExitAsync(ct).ConfigureAwait(false);
                    if (process.ExitCode != 0)
                        throw new InvalidOperationException($"{name}: the child process exited with {process.ExitCode}");
                }
            )
            .ConfigureAwait(false);
    }
}

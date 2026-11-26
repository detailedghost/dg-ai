using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Http;
using Dg.Core.Transport.Ipc;
using Dg.Core.Transport.Pool;

namespace Dg.Bench;

internal static class Child
{
    public static async Task<int> RunAsync(string transport, string endpoint)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            if (transport == "ipc")
                await SendIpcAsync(endpoint, cts.Token).ConfigureAwait(false);
            else
                await SendHttpAsync(int.Parse(endpoint), cts.Token).ConfigureAwait(false);
            return 0;
        }
        catch (Exception error)
        {
            await Console.Error.WriteLineAsync($"dg-bench child {transport}: {error.Message}").ConfigureAwait(false);
            return 1;
        }
    }

    private static async Task SendIpcAsync(string socketPath, CancellationToken ct)
    {
        var connector = new IpcConnector(new FixedSocketResolver(socketPath));
        var stream = await connector.ConnectAsync(Fixtures.PluginName, ct).ConfigureAwait(false);
        await using var connection = new PluginConnection(stream);
        using var frame = FrameWriter.Encode(
            FrameEncoding.Json,
            FrameFlags.None,
            connection.NextRequestId(),
            Fixtures.EnvelopePayload
        );
        await connection.SendAsync(frame.Memory, ct).ConfigureAwait(false);
    }

    private static async Task SendHttpAsync(int port, CancellationToken ct)
    {
        await using var transport = new HttpTransport(Fixtures.HttpManifest(port), false, new FixedTokenProvider());
        using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, 1, Fixtures.EnvelopePayload);
        await transport.SendAsync(frame.Memory, ct).ConfigureAwait(false);
    }
}

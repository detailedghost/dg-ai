using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Transport.Http;

namespace Dg.Core.Tests.Leaks;

[Collection(LeakCollection.Name)]
public sealed class ProviderLeakTests
{
    private const int Moves = 2_000;

    private sealed class Tokens : IPluginTokenProvider
    {
        public ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct) => new("tok");
    }

    private sealed class LiveCountFactory : IHttpTransportFactory
    {
        public int Live;

        public IPluginTransport Create(PluginManifest manifest, bool allowRemote)
        {
            Interlocked.Increment(ref Live);
            return new Counted(this);
        }
    }

    private sealed class Counted(LiveCountFactory owner) : IPluginTransport
    {
        public ValueTask<PluginResponse> SendAsync(ReadOnlyMemory<byte> frame, CancellationToken ct) =>
            throw new NotSupportedException();

        public ValueTask DisposeAsync()
        {
            Interlocked.Decrement(ref owner.Live);
            return ValueTask.CompletedTask;
        }
    }

    private static PluginManifest Manifest(int port) => TestManifest.Http($"http://127.0.0.1:{port}");

    [Fact]
    public async Task OpenAsync_ManyEndpointMoves_LeavesOnlyTheCurrentTransportAlive()
    {
        var factory = new LiveCountFactory();
        await using var provider = new HttpTransportProvider(factory);

        for (var i = 0; i < Moves; i++)
            await (await provider.OpenAsync(Manifest(1 + i), false, CancellationToken.None)).DisposeAsync();

        Assert.Equal(1, factory.Live);
    }

    [Fact]
    public async Task OpenAsync_ManyEndpointMoves_KeepsMemoryFlat()
    {
        await using var provider = new HttpTransportProvider(new HttpTransportFactory(new Tokens()));
        var port = 0;

        var report = await LeakMeter.MeasureAsync(
            async () =>
                await (await provider.OpenAsync(Manifest(1 + port++), false, CancellationToken.None)).DisposeAsync(),
            batches: 5,
            perBatch: 1_000,
            warmup: 100
        );

        Assert.True(report.BytesPerIteration < 100, $"retired transports leak {report.BytesPerIteration:F0} bytes per endpoint move");
    }
}

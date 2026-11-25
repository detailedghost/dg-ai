using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Transport.Http;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class HttpTransportProviderTests
{
    private static PluginManifest Manifest(string endpoint, bool remote = false) =>
        new(
            "scanner",
            "1.0.0",
            PluginKind.Hook,
            PluginTransportKind.Http,
            endpoint,
            remote,
            null,
            null,
            new(null, "scanner", []),
            new(false, [], [], []),
            new([], [])
        );

    [Fact]
    public async Task OpenAsync_SameNameWithNewEndpoint_BuildsANewTransport()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);

        var first = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        var again = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        var moved = await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        Assert.Same(first, again);
        Assert.NotSame(first, moved);
        Assert.Equal(2, factory.Created);
    }

    [Fact]
    public async Task OpenAsync_RemoteFlagChanges_BuildsANewTransport()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);

        var local = await provider.OpenAsync(Manifest("https://127.0.0.1:1"), true, CancellationToken.None);
        var remote = await provider.OpenAsync(Manifest("https://127.0.0.1:1", remote: true), true, CancellationToken.None);

        Assert.NotSame(local, remote);
    }

    [Fact]
    public async Task OpenAsync_EndpointMoves_KeepsTheReplacedTransportAliveForInFlightCallers()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);

        await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        Assert.Equal(0, factory.Disposed);
    }

    [Fact]
    public async Task DisposeAsync_AfterReplacement_DisposesEveryTransport()
    {
        var factory = new CountingFactory();
        var provider = new HttpTransportProvider(factory);
        await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        await provider.DisposeAsync();

        Assert.Equal(2, factory.Disposed);
    }

    [Fact]
    public async Task DisposeAsync_OneTransportThrows_StillDisposesTheRest()
    {
        var factory = new CountingFactory { ThrowOnDispose = true };
        var provider = new HttpTransportProvider(factory);
        await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        await Assert.ThrowsAsync<AggregateException>(async () => await provider.DisposeAsync());

        Assert.Equal(2, factory.Disposed);
    }

    [Fact]
    public async Task OpenAsync_FactoryFailsOnce_RetriesOnTheNextCall()
    {
        var factory = new CountingFactory { FailFirst = true };
        await using var provider = new HttpTransportProvider(factory);

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None)
        );
        var transport = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);

        Assert.NotNull(transport);
    }

    private sealed class CountingFactory : IHttpTransportFactory
    {
        public int Created { get; private set; }

        public int Disposed { get; private set; }

        public bool ThrowOnDispose { get; init; }

        public void RecordDispose() => Disposed++;

        public bool FailFirst { get; init; }

        public IPluginTransport Create(PluginManifest manifest, bool allowRemote)
        {
            if (FailFirst && Created == 0)
            {
                Created++;
                throw new InvalidOperationException("first attempt fails");
            }
            Created++;
            return new CountedTransport(this);
        }
    }

    private sealed class CountedTransport(CountingFactory owner) : IPluginTransport
    {
        public ValueTask<PluginResponse> SendAsync(ReadOnlyMemory<byte> frame, CancellationToken ct) =>
            throw new NotSupportedException();

        public ValueTask DisposeAsync()
        {
            owner.RecordDispose();
            return owner.ThrowOnDispose
                ? throw new InvalidOperationException("dispose fails")
                : ValueTask.CompletedTask;
        }
    }
}

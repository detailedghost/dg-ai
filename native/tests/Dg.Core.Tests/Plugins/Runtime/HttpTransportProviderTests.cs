using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Transport.Http;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class HttpTransportProviderTests
{
    private static PluginManifest Manifest(string endpoint, bool remote = false) => TestManifest.Http(endpoint, remote);

    [Fact]
    public async Task OpenAsync_SameNameWithNewEndpoint_BuildsANewTransport()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);

        var first = (await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None)).Transport;
        var again = (await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None)).Transport;
        var moved = (await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None)).Transport;

        Assert.Same(first, again);
        Assert.NotSame(first, moved);
        Assert.Equal(2, factory.Created);
    }

    [Fact]
    public async Task OpenAsync_RemoteFlagChanges_BuildsANewTransport()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);

        var local = (await provider.OpenAsync(Manifest("https://127.0.0.1:1"), true, CancellationToken.None)).Transport;
        var remote = (
            await provider.OpenAsync(Manifest("https://127.0.0.1:1", remote: true), true, CancellationToken.None)
        ).Transport;

        Assert.NotSame(local, remote);
    }

    [Fact]
    public async Task OpenAsync_EndpointMoves_KeepsTheReplacedTransportAliveWhileALeaseIsHeld()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);

        await using var held = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        Assert.Equal(0, factory.Disposed);
    }

    [Fact]
    public async Task LeaseDispose_AfterEndpointMove_DisposesTheReplacedTransportOnce()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);
        var held = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        var second = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        await held.DisposeAsync();
        Assert.Equal(0, factory.Disposed);
        await second.DisposeAsync();

        Assert.Equal(1, factory.Disposed);
        await second.DisposeAsync();
        Assert.Equal(1, factory.Disposed);
    }

    [Fact]
    public async Task LeaseDispose_CalledTwice_ReleasesOnce()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);
        var first = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await using var second = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        await first.DisposeAsync();
        await first.DisposeAsync();

        Assert.Equal(0, factory.Disposed);
    }

    [Fact]
    public async Task LeaseDispose_ConcurrentCalls_ReleaseOnce()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);
        var first = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await using var second = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => first.DisposeAsync().AsTask())));

        Assert.Equal(0, factory.Disposed);
    }

    [Fact]
    public async Task OpenAsync_RetiredTransportThrowsOnDispose_SurfacesFromProviderDispose()
    {
        var factory = new CountingFactory { ThrowOnDispose = true };
        var provider = new HttpTransportProvider(factory);
        await (await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None)).DisposeAsync();
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        var failure = await Assert.ThrowsAsync<AggregateException>(async () => await provider.DisposeAsync());

        Assert.Equal(2, failure.InnerExceptions.Count);
    }

    [Fact]
    public async Task OpenAsync_EndpointMovesWithNoLease_DisposesTheReplacedTransportAtOnce()
    {
        var factory = new CountingFactory();
        await using var provider = new HttpTransportProvider(factory);

        await (await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None)).DisposeAsync();
        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);

        Assert.Equal(1, factory.Disposed);
    }

    [Fact]
    public async Task SendAsync_EndpointMovesMidFlight_CompletesBeforeTheReplacedTransportIsDisposed()
    {
        var factory = new CountingFactory { SendGate = new TaskCompletionSource() };
        await using var provider = new HttpTransportProvider(factory);
        var lease = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);
        var inFlight = lease.Transport.SendAsync(default, CancellationToken.None).AsTask();

        await provider.OpenAsync(Manifest("http://127.0.0.1:2"), false, CancellationToken.None);
        Assert.Equal(0, factory.Disposed);
        factory.SendGate.SetResult();
        await inFlight;
        await lease.DisposeAsync();

        Assert.Equal(1, factory.Disposed);
        Assert.False(factory.DisposedWhileSending);
    }

    [Fact]
    public async Task OpenAsync_AfterDispose_Throws()
    {
        var provider = new HttpTransportProvider(new CountingFactory());
        await provider.DisposeAsync();

        await Assert.ThrowsAsync<ObjectDisposedException>(async () =>
            await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None)
        );
    }

    [Fact]
    public async Task LeaseDispose_AfterProviderDispose_DoesNotDisposeTwice()
    {
        var factory = new CountingFactory();
        var provider = new HttpTransportProvider(factory);
        var lease = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);

        await provider.DisposeAsync();
        await lease.DisposeAsync();

        Assert.Equal(1, factory.Disposed);
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
        var lease = await provider.OpenAsync(Manifest("http://127.0.0.1:1"), false, CancellationToken.None);

        Assert.NotNull(lease.Transport);
    }

    private sealed class CountingFactory : IHttpTransportFactory
    {
        public int Created { get; private set; }

        public int Disposed { get; private set; }

        public bool ThrowOnDispose { get; init; }

        public void RecordDispose() => Disposed++;

        public bool FailFirst { get; init; }

        public TaskCompletionSource? SendGate { get; init; }

        public bool Sending { get; set; }

        public bool DisposedWhileSending { get; set; }

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
        public async ValueTask<PluginResponse> SendAsync(ReadOnlyMemory<byte> frame, CancellationToken ct)
        {
            if (owner.SendGate is not { } gate)
                throw new NotSupportedException();
            owner.Sending = true;
            await gate.Task;
            owner.Sending = false;
            return default;
        }

        public ValueTask DisposeAsync()
        {
            owner.DisposedWhileSending |= owner.Sending;
            owner.RecordDispose();
            return owner.ThrowOnDispose
                ? throw new InvalidOperationException("dispose fails")
                : ValueTask.CompletedTask;
        }
    }
}

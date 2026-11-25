using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Transport.Http;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class HttpTransportProviderTests
{
    private static PluginManifest Manifest(string endpoint) =>
        new(
            "scanner",
            "1.0.0",
            PluginKind.Hook,
            PluginTransportKind.Http,
            endpoint,
            false,
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

    private sealed class CountingFactory : IHttpTransportFactory
    {
        public int Created { get; private set; }

        public IPluginTransport Create(PluginManifest manifest, bool allowRemote)
        {
            Created++;
            return new NullTransport();
        }
    }

    private sealed class NullTransport : IPluginTransport
    {
        public ValueTask<PluginResponse> SendAsync(ReadOnlyMemory<byte> frame, CancellationToken ct) =>
            throw new NotSupportedException();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

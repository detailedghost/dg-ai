using Dg.Core.Transport.Http;

namespace Dg.Bench;

internal sealed class FixedTokenProvider : IPluginTokenProvider
{
    public ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct) =>
        ValueTask.FromResult<string?>(Fixtures.Token);
}

internal sealed class FixedSocketResolver(string path) : Dg.Core.Transport.Ipc.IIpcEndpointResolver
{
    public string SocketPath(string plugin) => path;
}

using Dg.Core.Credentials;

namespace Dg.Cli;

internal sealed class UnavailableCredentialStore : ICredentialStore
{
    public ValueTask<string?> GetAsync(string name, CancellationToken cancellationToken) =>
        ValueTask.FromResult<string?>(null);
}

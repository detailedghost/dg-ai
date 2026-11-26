using Dg.Core.Credentials;

namespace Dg.Core.Tests.Plugins.Runtime;

internal sealed class MapCredentialStore : ICredentialStore
{
    public Dictionary<string, string> Values { get; } = [];

    public Exception? Failure { get; set; }

    public int Reads { get; private set; }

    public CancellationToken LastToken { get; private set; }

    public ValueTask<string?> GetAsync(string name, CancellationToken cancellationToken)
    {
        Reads++;
        LastToken = cancellationToken;
        cancellationToken.ThrowIfCancellationRequested();
        return Failure is null ? ValueTask.FromResult(Values.GetValueOrDefault(name)) : throw Failure;
    }
}

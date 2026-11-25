namespace Dg.Core.Transport.Http;

public interface IPluginTokenProvider
{
    ValueTask<string?> GetTokenAsync(string credentialName, CancellationToken ct);
}

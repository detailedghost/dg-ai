namespace Dg.Core.Plugins.Runtime;

public interface IApprovalSigner
{
    ValueTask<bool> VerifyApprovalAsync(string[] fields, string mac, CancellationToken cancellationToken);

    ValueTask<string> SignStatCacheAsync(string[] fields, CancellationToken cancellationToken);

    ValueTask<bool> VerifyStatCacheAsync(string[] fields, string mac, CancellationToken cancellationToken);
}

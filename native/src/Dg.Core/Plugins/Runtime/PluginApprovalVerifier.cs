namespace Dg.Core.Plugins.Runtime;

public sealed class PluginApprovalVerifier
{
    private readonly IApprovalSigner _signer;
    private readonly TimeProvider _clock;
    private readonly Func<string, string> _hashTree;

    public PluginApprovalVerifier(IApprovalSigner signer, TimeProvider? clock = null)
        : this(signer, clock, null) { }

    internal PluginApprovalVerifier(IApprovalSigner signer, TimeProvider? clock, Func<string, string>? hashTree)
    {
        _signer = signer;
        _clock = clock ?? TimeProvider.System;
        _hashTree = hashTree ?? PluginApproval.HashTree;
    }

    public async ValueTask<string?> ProblemAsync(string name, string folder, CancellationToken ct)
    {
        var record = PluginApprovalRecord.Read(folder);
        if (record is null || !record.HasApproval)
            return $"Next: review it, then run dg plugin verify {name} --approve.";
        if (PluginApproval.HasNul(record))
            return "A signed field holds a NUL byte, so dg never approves it. Next: remove the plugin and add it again.";
        if (record.Mac is null)
            return $"It has no signed approval. Next: {Reapprove(name)}.";
        bool verified;
        try
        {
            verified = await _signer.VerifyApprovalAsync(record.SignedFields(), record.Mac, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return $"Cannot verify the approval with the dg daemon: {ex.Message}. Next: start the dg daemon with dg agent start, then try again.";
        }
        if (!verified)
            return $"Its approval signature does not verify. Next: {Reapprove(name)}.";
        return await TreeProblemAsync(name, folder, record, ct).ConfigureAwait(false);
    }

    private async ValueTask<string?> TreeProblemAsync(string name, string folder, PluginApprovalRecord record, CancellationToken ct)
    {
        var src = Path.Combine(folder, "src");
        if (!Directory.Exists(src))
            return $"Its files are missing. Next: {Reapprove(name)}.";
        try
        {
            var stamps = PluginStatCache.Snapshot(src);
            var now = _clock.GetUtcNow();
            if (await PluginStatCache.AttestsAsync(folder, _signer, record.TreeSha256, stamps, now, ct).ConfigureAwait(false))
                return null;
            if (!string.Equals(_hashTree(src), record.TreeSha256, StringComparison.Ordinal))
                return $"Its files changed since approval. Next: {Reapprove(name)}.";
            await PluginStatCache.SaveAsync(folder, _signer, record.TreeSha256, stamps, now, ct).ConfigureAwait(false);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return $"Its files cannot be read: {ex.Message}. Next: {Reapprove(name)}.";
        }
    }

    private static string Reapprove(string name) => $"re-approve with dg plugin verify {name} --approve";
}

using Dg.Core.Credentials;

namespace Dg.Core.Plugins.Runtime;

public sealed class PluginApprovalVerifier(
    ICredentialStore credentials,
    TimeProvider? clock = null,
    Func<string, string>? hashTree = null
)
{
    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly Func<string, string> _hashTree = hashTree ?? PluginApproval.HashTree;
    private byte[]? _key;

    public async ValueTask<string?> ProblemAsync(string name, string folder, CancellationToken ct)
    {
        var record = PluginApprovalRecord.Read(folder);
        if (record is null || !record.HasApproval)
            return $"Next: review it, then run dg plugin verify {name} --approve.";
        if (record.Mac is null)
            return $"It has no signed approval. Next: {Reapprove(name)}.";
        byte[]? key;
        try
        {
            key = await KeyAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return $"Cannot read the approval key: {ex.Message}. Next: start the dg daemon with dg agent start, then try again.";
        }
        if (key is null)
            return $"There is no approval key in the dg credential store. Next: {Reapprove(name)}.";
        if (!PluginApproval.MacMatches(key, record))
            return $"Its approval signature does not verify. Next: {Reapprove(name)}.";
        return TreeProblem(name, folder, record, key);
    }

    private string? TreeProblem(string name, string folder, PluginApprovalRecord record, byte[] key)
    {
        var src = Path.Combine(folder, "src");
        if (!Directory.Exists(src))
            return $"Its files are missing. Next: {Reapprove(name)}.";
        try
        {
            var stamps = PluginStatCache.Snapshot(src);
            var now = _clock.GetUtcNow();
            if (PluginStatCache.Attests(folder, key, record.TreeSha256, stamps, now))
                return null;
            if (!string.Equals(_hashTree(src), record.TreeSha256, StringComparison.Ordinal))
                return $"Its files changed since approval. Next: {Reapprove(name)}.";
            PluginStatCache.Save(folder, key, record.TreeSha256, stamps, now);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return $"Its files cannot be read: {ex.Message}. Next: {Reapprove(name)}.";
        }
    }

    private async ValueTask<byte[]?> KeyAsync(CancellationToken ct)
    {
        if (_key is not null)
            return _key;
        var hex = await credentials.GetAsync(PluginApproval.KeyCredential, ct).ConfigureAwait(false);
        return PluginApproval.TryDecode32(hex, out var key) ? _key = key : null;
    }

    private static string Reapprove(string name) => $"re-approve with dg plugin verify {name} --approve";
}

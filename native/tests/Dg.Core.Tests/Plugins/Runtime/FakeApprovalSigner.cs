using System.Security.Cryptography;
using System.Text;
using Dg.Core.Plugins.Runtime;

namespace Dg.Core.Tests.Plugins.Runtime;

internal sealed class FakeApprovalSigner : IApprovalSigner
{
    private const string ApprovalDomain = "dg-plugin-approval-v1";
    private const string StatCacheDomain = "dg-plugin-statcache-v1";

    public byte[]? Key { get; set; } = ApprovalFixture.Key;

    public Exception? Failure { get; set; }

    public int ApprovalVerifies { get; private set; }

    public int StatCacheSigns { get; private set; }

    public int StatCacheVerifies { get; private set; }

    public string[]? LastApprovalFields { get; private set; }

    public CancellationToken LastToken { get; private set; }

    public static string Mac(byte[] key, string domain, string[] fields) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(string.Join('\0', [domain, .. fields]))));

    public ValueTask<bool> VerifyApprovalAsync(string[] fields, string mac, CancellationToken cancellationToken)
    {
        Enter(cancellationToken);
        ApprovalVerifies++;
        LastApprovalFields = fields;
        return ValueTask.FromResult(Matches(ApprovalDomain, fields, mac));
    }

    public ValueTask<string> SignStatCacheAsync(string[] fields, CancellationToken cancellationToken)
    {
        Enter(cancellationToken);
        StatCacheSigns++;
        return ValueTask.FromResult(Mac(Key ?? throw new InvalidOperationException("no key"), StatCacheDomain, fields));
    }

    public ValueTask<bool> VerifyStatCacheAsync(string[] fields, string mac, CancellationToken cancellationToken)
    {
        Enter(cancellationToken);
        StatCacheVerifies++;
        return ValueTask.FromResult(Matches(StatCacheDomain, fields, mac));
    }

    private void Enter(CancellationToken cancellationToken)
    {
        LastToken = cancellationToken;
        cancellationToken.ThrowIfCancellationRequested();
        if (Failure is not null)
            throw Failure;
    }

    private bool Matches(string domain, string[] fields, string mac) =>
        Key is not null
        && CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(Mac(Key, domain, fields)),
            Encoding.ASCII.GetBytes(mac)
        );
}

using System.Security.Cryptography;
using System.Text;

namespace Dg.Core.Plugins.Runtime;

public static class PluginApproval
{
    public const string KeyCredential = "dg/plugin-approval-key";
    private const string MacDomain = "dg-plugin-approval-v1";
    private const int MacByteLength = 32;

    public static string ComputeMac(ReadOnlySpan<byte> key, PluginApprovalRecord record) =>
        Convert.ToHexStringLower(MacBytes(key, record));

    public static bool MacMatches(ReadOnlySpan<byte> key, PluginApprovalRecord record) =>
        !ContainsNul(record)
        && TryDecode32(record.Mac, out var claimed)
        && CryptographicOperations.FixedTimeEquals(MacBytes(key, record), claimed);

    public static bool TryDecode32(string? hex, out byte[] bytes)
    {
        bytes = [];
        if (hex is not { Length: MacByteLength * 2 } || !IsLowerHex(hex))
            return false;
        bytes = Convert.FromHexString(hex);
        return true;
    }

    private static byte[] MacBytes(ReadOnlySpan<byte> key, PluginApprovalRecord record)
    {
        if (ContainsNul(record))
            throw new ArgumentException("a signed field contains a NUL byte", nameof(record));
        using var hmac = IncrementalHash.CreateHMAC(HashAlgorithmName.SHA256, key);
        HmacFields.Append(hmac, MacDomain, first: true);
        foreach (var field in record.SignedFields())
            HmacFields.Append(hmac, field);
        return hmac.GetHashAndReset();
    }

    public static string HashTree(string root)
    {
        var files = ListFiles(root);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var rel in files)
        {
            var content = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(root, rel))));
            hash.AppendData(Encoding.UTF8.GetBytes($"{rel}\0{content}\n"));
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public static List<string> ListFiles(string root)
    {
        var files = new List<string>();
        Walk(root, "", files);
        files.Sort(StringComparer.Ordinal);
        return files;
    }

    private static bool ContainsNul(PluginApprovalRecord record)
    {
        foreach (var field in record.SignedFields())
            if (field.Contains('\0'))
                return true;
        return false;
    }

    private static bool IsLowerHex(string text)
    {
        foreach (var c in text)
            if (c is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
                return false;
        return true;
    }

    private static void Walk(string dir, string prefix, List<string> files)
    {
        foreach (var entry in new DirectoryInfo(dir).EnumerateFileSystemInfos())
        {
            var rel = prefix.Length == 0 ? entry.Name : $"{prefix}/{entry.Name}";
            if (prefix.Length == 0 && entry.Name == ".git")
                continue;
            if (entry.LinkTarget is not null)
                throw new InvalidOperationException($"{rel} is a symlink");
            if (entry is DirectoryInfo)
                Walk(entry.FullName, rel, files);
            else
                files.Add(rel);
        }
    }
}

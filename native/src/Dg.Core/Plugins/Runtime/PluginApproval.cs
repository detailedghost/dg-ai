using System.Security.Cryptography;
using System.Text;

namespace Dg.Core.Plugins.Runtime;

public static class PluginApproval
{
    private const int MacByteLength = 32;

    public static bool HasNul(PluginApprovalRecord record)
    {
        foreach (var field in record.SignedFields())
            if (field.Contains('\0'))
                return true;
        return false;
    }

    public static bool TryDecode32(string? hex, out byte[] bytes)
    {
        bytes = [];
        if (hex is not { Length: MacByteLength * 2 } || !IsLowerHex(hex))
            return false;
        bytes = Convert.FromHexString(hex);
        return true;
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

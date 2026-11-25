using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Dg.Core.Plugins.Runtime;

public static class PluginApproval
{
    private const string RecordFile = "dg-plugin.json";

    public static bool IsApproved(string folder)
    {
        var file = Path.Combine(folder, RecordFile);
        if (!File.Exists(file))
            return false;
        string? tree;
        string? approved;
        try
        {
            using var record = JsonDocument.Parse(File.ReadAllBytes(file));
            tree = Read(record.RootElement, "treeSha256");
            approved = Read(record.RootElement, "approvedSha256");
        }
        catch (Exception ex) when (ex is JsonException or IOException or InvalidOperationException)
        {
            return false;
        }
        if (approved is null || tree is null || !string.Equals(approved, tree, StringComparison.Ordinal))
            return false;
        var src = Path.Combine(folder, "src");
        if (!Directory.Exists(src))
            return false;
        try
        {
            return string.Equals(HashTree(src), tree, StringComparison.Ordinal);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return false;
        }
    }

    public static string HashTree(string root)
    {
        var files = new List<string>();
        Walk(root, "", files);
        files.Sort(StringComparer.Ordinal);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var rel in files)
        {
            var content = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(root, rel))));
            hash.AppendData(Encoding.UTF8.GetBytes($"{rel}\0{content}\n"));
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static string? Read(JsonElement root, string key) =>
        root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

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

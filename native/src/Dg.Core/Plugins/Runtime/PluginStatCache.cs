using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace Dg.Core.Plugins.Runtime;

internal readonly record struct FileStamp(string RelativePath, long Size, long MtimeNs, ulong Inode);

internal static class PluginStatCache
{
    public const string FileName = "stat-cache.json";
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);
    private const string MacDomain = "dg-plugin-statcache-v1";
    private const long TickNs = 100;

    public static FileStamp[] Snapshot(string src)
    {
        var files = PluginApproval.ListFiles(src);
        var stamps = new FileStamp[files.Count];
        for (var i = 0; i < stamps.Length; i++)
        {
            var path = Path.Combine(src, files[i]);
            var info = new FileInfo(path);
            var mtimeNs = info.LastWriteTimeUtc.Ticks * TickNs;
            stamps[i] = new FileStamp(files[i], info.Length, mtimeNs, FileIdentity.Of(path));
        }
        return stamps;
    }

    public static bool Attests(
        string folder,
        ReadOnlySpan<byte> key,
        string treeSha256,
        FileStamp[] current,
        DateTimeOffset now
    )
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(folder, FileName)));
            var root = document.RootElement;
            var tree = root.GetProperty("treeSha256").GetString();
            var fullHashAt = root.GetProperty("fullHashAtMs").GetInt64();
            var files = root.GetProperty("files");
            if (tree is null || !PluginApproval.TryDecode32(root.GetProperty("mac").GetString(), out var claimed))
                return false;
            var stamps = new FileStamp[files.GetArrayLength()];
            var index = 0;
            foreach (var item in files.EnumerateArray())
                stamps[index++] = new FileStamp(
                    item.GetProperty("p").GetString() ?? "",
                    item.GetProperty("s").GetInt64(),
                    item.GetProperty("m").GetInt64(),
                    item.GetProperty("i").GetUInt64()
                );
            if (!CryptographicOperations.FixedTimeEquals(Sign(key, tree, fullHashAt, stamps), claimed))
                return false;
            var age = now - DateTimeOffset.FromUnixTimeMilliseconds(fullHashAt);
            return string.Equals(tree, treeSha256, StringComparison.Ordinal)
                && age >= TimeSpan.Zero
                && age < MaxAge
                && current.AsSpan().SequenceEqual(stamps);
        }
        catch (Exception ex)
            when (ex is JsonException
                    or IOException
                    or InvalidOperationException
                    or UnauthorizedAccessException
                    or KeyNotFoundException
                    or FormatException
                    or ArgumentException
            )
        {
            return false;
        }
    }

    public static void Save(
        string folder,
        ReadOnlySpan<byte> key,
        string treeSha256,
        FileStamp[] stamps,
        DateTimeOffset now
    )
    {
        var fullHashAt = now.ToUnixTimeMilliseconds();
        var mac = Convert.ToHexStringLower(Sign(key, treeSha256, fullHashAt, stamps));
        var target = Path.Combine(folder, FileName);
        var temp = $"{target}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        try
        {
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write))
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteString("treeSha256", treeSha256);
                writer.WriteNumber("fullHashAtMs", fullHashAt);
                writer.WriteStartArray("files");
                foreach (var stamp in stamps)
                {
                    writer.WriteStartObject();
                    writer.WriteString("p", stamp.RelativePath);
                    writer.WriteNumber("s", stamp.Size);
                    writer.WriteNumber("m", stamp.MtimeNs);
                    writer.WriteNumber("i", stamp.Inode);
                    writer.WriteEndObject();
                }
                writer.WriteEndArray();
                writer.WriteString("mac", mac);
                writer.WriteEndObject();
            }
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            File.Move(temp, target, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            try
            {
                File.Delete(temp);
            }
            catch (Exception inner) when (inner is IOException or UnauthorizedAccessException) { }
        }
    }

    private static byte[] Sign(ReadOnlySpan<byte> key, string treeSha256, long fullHashAt, FileStamp[] stamps)
    {
        using var hmac = IncrementalHash.CreateHMAC(HashAlgorithmName.SHA256, key);
        HmacFields.Append(hmac, MacDomain, first: true);
        HmacFields.Append(hmac, treeSha256);
        HmacFields.Append(hmac, fullHashAt.ToString(CultureInfo.InvariantCulture));
        HmacFields.Append(hmac, stamps.Length.ToString(CultureInfo.InvariantCulture));
        foreach (var stamp in stamps)
        {
            HmacFields.Append(hmac, stamp.RelativePath);
            HmacFields.Append(hmac, stamp.Size.ToString(CultureInfo.InvariantCulture));
            HmacFields.Append(hmac, stamp.MtimeNs.ToString(CultureInfo.InvariantCulture));
            HmacFields.Append(hmac, stamp.Inode.ToString(CultureInfo.InvariantCulture));
        }
        return hmac.GetHashAndReset();
    }
}

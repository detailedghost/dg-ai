using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace Dg.Core.Plugins.Runtime;

internal readonly record struct FileStamp(string RelativePath, long Size, long MtimeNs, ulong Inode);

internal static class PluginStatCache
{
    public const string FileName = "stat-cache.json";
    public static readonly TimeSpan MaxAge = TimeSpan.FromHours(24);
    private const long TickNs = 100;

    public static FileStamp[] Snapshot(string src)
    {
        var files = PluginApproval.ListFiles(src);
        var stamps = new FileStamp[files.Count];
        for (var i = 0; i < stamps.Length; i++)
        {
            var path = Path.Combine(src, files[i]);
            var info = new FileInfo(path);
            var mtimeNs = (info.LastWriteTimeUtc.Ticks - DateTime.UnixEpoch.Ticks) * TickNs;
            stamps[i] = new FileStamp(files[i], info.Length, mtimeNs, FileIdentity.Of(path));
        }
        return stamps;
    }

    public static async ValueTask<bool> AttestsAsync(
        string folder,
        IApprovalSigner signer,
        string treeSha256,
        FileStamp[] current,
        DateTimeOffset now,
        CancellationToken ct
    )
    {
        string tree;
        string mac;
        long fullHashAt;
        TimeSpan age;
        FileStamp[] stamps;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(folder, FileName)));
            var root = document.RootElement;
            tree = root.GetProperty("treeSha256").GetString() ?? "";
            fullHashAt = root.GetProperty("fullHashAtMs").GetInt64();
            age = now - DateTimeOffset.FromUnixTimeMilliseconds(fullHashAt);
            mac = root.GetProperty("mac").GetString() ?? "";
            var files = root.GetProperty("files");
            stamps = new FileStamp[files.GetArrayLength()];
            var index = 0;
            foreach (var item in files.EnumerateArray())
                stamps[index++] = new FileStamp(
                    item.GetProperty("p").GetString() ?? "",
                    item.GetProperty("s").GetInt64(),
                    item.GetProperty("m").GetInt64(),
                    item.GetProperty("i").GetUInt64()
                );
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
        if (
            !PluginApproval.TryDecode32(mac, out _)
            || !string.Equals(tree, treeSha256, StringComparison.Ordinal)
            || age < TimeSpan.Zero
            || age >= MaxAge
            || !current.AsSpan().SequenceEqual(stamps)
        )
            return false;
        try
        {
            return await signer.VerifyStatCacheAsync(Fields(tree, fullHashAt, stamps), mac, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return false;
        }
    }

    public static async ValueTask SaveAsync(
        string folder,
        IApprovalSigner signer,
        string treeSha256,
        FileStamp[] stamps,
        DateTimeOffset now,
        CancellationToken ct
    )
    {
        var fullHashAt = now.ToUnixTimeMilliseconds();
        string mac;
        try
        {
            mac = await signer.SignStatCacheAsync(Fields(treeSha256, fullHashAt, stamps), ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return;
        }
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
            TryDelete(temp);
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return;
        }
    }

    private static string[] Fields(string treeSha256, long fullHashAt, FileStamp[] stamps)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        HmacFields.Append(hash, stamps.Length.ToString(CultureInfo.InvariantCulture), first: true);
        foreach (var stamp in stamps)
        {
            HmacFields.Append(hash, stamp.RelativePath);
            HmacFields.Append(hash, stamp.Size.ToString(CultureInfo.InvariantCulture));
            HmacFields.Append(hash, stamp.MtimeNs.ToString(CultureInfo.InvariantCulture));
            HmacFields.Append(hash, stamp.Inode.ToString(CultureInfo.InvariantCulture));
        }
        return
        [
            treeSha256,
            fullHashAt.ToString(CultureInfo.InvariantCulture),
            Convert.ToHexStringLower(hash.GetHashAndReset()),
        ];
    }
}

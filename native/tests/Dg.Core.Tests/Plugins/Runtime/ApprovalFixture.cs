using System.Text;
using System.Text.Json;
using Dg.Core.Credentials;
using Dg.Core.Plugins.Runtime;
using Dg.Core.Tests.Plugins;

namespace Dg.Core.Tests.Plugins.Runtime;

internal sealed class ManualClock(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;

    public void Advance(TimeSpan by) => _now += by;

    public void Set(DateTimeOffset now) => _now = now;

    public override DateTimeOffset GetUtcNow() => _now;
}

internal sealed class MapCredentialStore : ICredentialStore
{
    public Dictionary<string, string> Values { get; } = [];

    public Exception? Failure { get; set; }

    public int Reads { get; private set; }

    public CancellationToken LastToken { get; private set; }

    public ValueTask<string?> GetAsync(string name, CancellationToken cancellationToken)
    {
        Reads++;
        LastToken = cancellationToken;
        cancellationToken.ThrowIfCancellationRequested();
        return Failure is null ? ValueTask.FromResult(Values.GetValueOrDefault(name)) : throw Failure;
    }
}

internal static class ApprovalFixture
{
    public const string KeyHex = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";

    public static byte[] Key => Convert.FromHexString(KeyHex);

    public static PluginApprovalRecord Signed(string name, string tree, byte[]? key = null)
    {
        var record = new PluginApprovalRecord(name, "skill", "folder", "sha256", tree, tree, tree, null);
        return record with { Mac = PluginApproval.ComputeMac(key ?? Key, record) };
    }

    public static void WriteRecord(string folder, PluginApprovalRecord record)
    {
        Directory.CreateDirectory(folder);
        var mac = record.Mac is null ? "null" : $"\"{record.Mac}\"";
        var approved = record.ApprovedSha256 is null ? "null" : $"\"{record.ApprovedSha256}\"";
        File.WriteAllText(
            Path.Combine(folder, "dg-plugin.json"),
            $$"""
            {"name":"{{record.Name}}","kind":"{{record.Kind}}","source":"{{record.Source}}","pin":{"kind":"{{record.PinKind}}","value":"{{record.PinValue}}"},"treeSha256":"{{record.TreeSha256}}","approvedSha256":{{approved}},"mac":{{mac}}}
            """,
            new UTF8Encoding(false)
        );
    }

    public static string WriteTree(string folder, params (string Path, string Text)[] files)
    {
        var src = Path.Combine(folder, "src");
        foreach (var (path, text) in files)
        {
            var full = Path.Combine(src, path);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, text);
        }
        return PluginApproval.HashTree(src);
    }

    public static JsonDocument Shared() => PluginFixtures.ReadJson("approval", "cases.json");
}

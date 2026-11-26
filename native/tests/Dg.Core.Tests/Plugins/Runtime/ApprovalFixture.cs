using System.Text;
using System.Text.Json;
using Dg.Core.Plugins.Runtime;

namespace Dg.Core.Tests.Plugins.Runtime;

internal static class ApprovalFixture
{
    public const string KeyHex = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";

    public static byte[] Key => Convert.FromHexString(KeyHex);

    public static PluginApprovalRecord Signed(string name, string tree, byte[]? key = null)
    {
        var record = new PluginApprovalRecord(name, "skill", "folder", "sha256", "pinned-value", tree, tree, null);
        return record with { Mac = FakeApprovalSigner.Mac(key ?? Key, FakeApprovalSigner.ApprovalDomain, record.SignedFields()) };
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

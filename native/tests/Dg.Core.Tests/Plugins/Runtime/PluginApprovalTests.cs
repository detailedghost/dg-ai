using System.Text.Json;
using Dg.Core.Plugins.Runtime;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class PluginApprovalTests
{
    private static string MaterializeFolder(JsonElement root)
    {
        var folder = Directory.CreateTempSubdirectory("dgapproval").FullName;
        foreach (var file in root.GetProperty("tree").EnumerateObject())
        {
            var full = Path.Combine(folder, "src", file.Name);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, file.Value.GetString());
        }
        return folder;
    }

    private static PluginApprovalRecord Load(JsonElement root, string name, string folder)
    {
        File.WriteAllText(Path.Combine(folder, "dg-plugin.json"), root.GetProperty("records").GetProperty(name).GetRawText());
        return PluginApprovalRecord.Read(folder)!;
    }

    [Fact]
    public void ComputeMac_SharedFixtureRecord_MatchesTheBunMac()
    {
        using var shared = ApprovalFixture.Shared();
        var root = shared.RootElement;
        var folder = MaterializeFolder(root);
        try
        {
            var record = Load(root, "signed", folder);

            var mac = PluginApproval.ComputeMac(Convert.FromHexString(root.GetProperty("key").GetString()!), record);

            Assert.Equal(root.GetProperty("expectedMac").GetString(), mac);
            Assert.Equal(mac, record.Mac);
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    [Fact]
    public void MacMatches_SignedBadUnsignedAndNullMacRecords_AreJudgedPerTheContract()
    {
        using var shared = ApprovalFixture.Shared();
        var root = shared.RootElement;
        var key = Convert.FromHexString(root.GetProperty("key").GetString()!);
        var folder = MaterializeFolder(root);
        try
        {
            Assert.True(PluginApproval.MacMatches(key, Load(root, "signed", folder)));
            Assert.False(PluginApproval.MacMatches(key, Load(root, "badMac", folder)));
            Assert.False(PluginApproval.MacMatches(key, Load(root, "unsigned", folder)));
            Assert.False(PluginApproval.MacMatches(key, Load(root, "unsignedNull", folder)));
            Assert.False(PluginApproval.MacMatches(new byte[32], Load(root, "signed", folder)));
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    [Fact]
    public void HashTree_SharedFixtureFiles_MatchesTheRecordedTreeHash()
    {
        using var shared = ApprovalFixture.Shared();
        var root = shared.RootElement;
        var folder = MaterializeFolder(root);
        try
        {
            var tree = PluginApproval.HashTree(Path.Combine(folder, "src"));

            Assert.Equal(root.GetProperty("records").GetProperty("signed").GetProperty("treeSha256").GetString(), tree);
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    [Fact]
    public void Read_RecordWithSixKeys_ParsesAsUnsigned()
    {
        var folder = Directory.CreateTempSubdirectory("dgapproval").FullName;
        try
        {
            File.WriteAllText(
                Path.Combine(folder, "dg-plugin.json"),
                """{"name":"a","kind":"skill","source":"s","pin":{"kind":"sha256","value":"v"},"treeSha256":"t","approvedSha256":"t"}"""
            );

            var record = PluginApprovalRecord.Read(folder);

            Assert.NotNull(record);
            Assert.Null(record.Mac);
            Assert.True(record.HasApproval);
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    [Theory]
    [InlineData("""{"treeSha256":"t","approvedSha256":"t"}""")]
    [InlineData("not json")]
    public void Read_UnparseableOrShortRecord_IsNull(string json)
    {
        var folder = Directory.CreateTempSubdirectory("dgapproval").FullName;
        try
        {
            File.WriteAllText(Path.Combine(folder, "dg-plugin.json"), json);

            Assert.Null(PluginApprovalRecord.Read(folder));
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    [Theory]
    [InlineData("00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f", true)]
    [InlineData("00112233445566778899AABBCCDDEEFF102132435465768798a9bacbdcedfe0f", false)]
    [InlineData("0011", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void TryDecode32_OnlyLowercaseHexOf32Bytes_Decodes(string? hex, bool expected)
    {
        Assert.Equal(expected, PluginApproval.TryDecode32(hex, out var key));
        Assert.Equal(expected, key.Length == 32);
    }
}

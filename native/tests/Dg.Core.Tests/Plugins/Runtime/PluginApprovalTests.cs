using System.Text.Json;
using Dg.Core.Plugins.Runtime;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class PluginApprovalTests
{
    private static TempFolder Materialize(JsonElement root)
    {
        var folder = new TempFolder();
        foreach (var file in root.GetProperty("tree").EnumerateObject())
        {
            var full = Path.Combine(folder.Path, "src", file.Name);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, file.Value.GetString());
        }
        return folder;
    }

    private static PluginApprovalRecord Load(JsonElement root, string name, TempFolder folder)
    {
        var json = root.GetProperty("records").GetProperty(name).GetRawText();
        File.WriteAllText(Path.Combine(folder.Path, "dg-plugin.json"), json);
        return PluginApprovalRecord.Read(folder.Path)!;
    }

    [Fact]
    public async Task ProblemAsync_SharedFixtureRecords_AreJudgedPerTheContractAndTheDaemonSeesTheSharedFields()
    {
        using var shared = ApprovalFixture.Shared();
        var root = shared.RootElement;
        var signer = new FakeApprovalSigner { Key = Convert.FromHexString(root.GetProperty("key").GetString()!) };
        var verifier = new PluginApprovalVerifier(signer);
        foreach (var (name, approved) in new[]
        {
            ("signed", true),
            ("badMac", false),
            ("unsigned", false),
            ("unsignedNull", false),
            ("nul-in-source", false),
        })
        {
            using var folder = Materialize(root);
            Load(root, name, folder);
            var problem = await verifier.ProblemAsync("demo", folder.Path, CancellationToken.None);
            Assert.True(approved == (problem is null), $"{name}: {problem ?? "approved"}");
        }

        using var last = Materialize(root);
        var signed = Load(root, "signed", last);
        var json = root.GetProperty("records").GetProperty("signed");
        Assert.Equal(
            [
                json.GetProperty("name").GetString(),
                json.GetProperty("kind").GetString(),
                json.GetProperty("source").GetString(),
                json.GetProperty("pin").GetProperty("kind").GetString(),
                json.GetProperty("pin").GetProperty("value").GetString(),
                json.GetProperty("treeSha256").GetString(),
                json.GetProperty("approvedSha256").GetString(),
            ],
            signed.SignedFields()
        );
        Assert.Equal(
            root.GetProperty("expectedMac").GetString(),
            FakeApprovalSigner.Mac(signer.Key!, FakeApprovalSigner.ApprovalDomain, signed.SignedFields())
        );
    }

    [Fact]
    public void HashTree_SharedFixtureFiles_MatchesTheRecordedTreeHash()
    {
        using var shared = ApprovalFixture.Shared();
        var root = shared.RootElement;
        using var folder = Materialize(root);
        var tree = PluginApproval.HashTree(Path.Combine(folder.Path, "src"));

        Assert.Equal(root.GetProperty("records").GetProperty("signed").GetProperty("treeSha256").GetString(), tree);
    }

    [Fact]
    public void Read_RecordWithSixKeys_ParsesAsUnsigned()
    {
        using var folder = new TempFolder();
        File.WriteAllText(
            Path.Combine(folder.Path, "dg-plugin.json"),
            """{"name":"a","kind":"skill","source":"s","pin":{"kind":"sha256","value":"v"},"treeSha256":"t","approvedSha256":"t"}"""
        );

        var record = PluginApprovalRecord.Read(folder.Path);

        Assert.NotNull(record);
        Assert.Null(record.Mac);
        Assert.True(record.HasApproval);
    }

    [Theory]
    [InlineData("""{"treeSha256":"t","approvedSha256":"t"}""")]
    [InlineData("not json")]
    public void Read_UnparseableOrShortRecord_IsNull(string json)
    {
        using var folder = new TempFolder();
        File.WriteAllText(Path.Combine(folder.Path, "dg-plugin.json"), json);

        Assert.Null(PluginApprovalRecord.Read(folder.Path));
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

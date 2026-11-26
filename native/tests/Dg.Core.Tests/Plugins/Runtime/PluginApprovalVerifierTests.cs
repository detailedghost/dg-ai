using Dg.Core.Plugins.Runtime;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class PluginApprovalVerifierTests : IDisposable
{
    private const string Name = "scanner";
    private static readonly DateTimeOffset Start = new(2026, 11, 25, 12, 0, 0, TimeSpan.Zero);
    private readonly string _root = Directory.CreateTempSubdirectory("dgverifier").FullName;
    private readonly ManualClock _clock = new(Start);
    private readonly MapCredentialStore _store = new();
    private readonly PluginApprovalVerifier _verifier;
    private int _hashes;

    public PluginApprovalVerifierTests()
    {
        _store.Values["dg/plugin-approval-key"] = ApprovalFixture.KeyHex;
        _verifier = new PluginApprovalVerifier(
            _store,
            _clock,
            src =>
            {
                _hashes++;
                return PluginApproval.HashTree(src);
            }
        );
        Folder = Path.Combine(_root, Name);
        Tree = ApprovalFixture.WriteTree(Folder, ("plugin.toml", "name = \"scanner\"\n"), ("lib/main.txt", "body"));
        ApprovalFixture.WriteRecord(Folder, ApprovalFixture.Signed(Name, Tree));
    }

    private string Folder { get; }

    private string Tree { get; }

    private string CachePath => Path.Combine(Folder, "stat-cache.json");

    private ValueTask<string?> Problem() => _verifier.ProblemAsync(Name, Folder, CancellationToken.None);

    public void Dispose() => Directory.Delete(_root, true);

    [Fact]
    public async Task ProblemAsync_SignedIntactPlugin_IsApproved()
    {
        Assert.Null(await Problem());
    }

    [Fact]
    public async Task ProblemAsync_SecondCallWithNothingChanged_SkipsHashing()
    {
        await Problem();
        await Problem();
        await Problem();

        Assert.Equal(1, _hashes);
        Assert.True(File.Exists(CachePath));
    }

    [Fact]
    public async Task ProblemAsync_FileContentChangesWithNewSize_Rehashes()
    {
        await Problem();
        File.WriteAllText(Path.Combine(Folder, "src", "lib", "main.txt"), "longer body");

        Assert.Contains("changed since approval", await Problem());
        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_OnlyMtimeChangesButContentSame_RehashesAndStaysApproved()
    {
        await Problem();
        File.SetLastWriteTimeUtc(Path.Combine(Folder, "src", "lib", "main.txt"), Start.UtcDateTime.AddDays(-3));

        Assert.Null(await Problem());
        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_FileAdded_Rehashes()
    {
        await Problem();
        File.WriteAllText(Path.Combine(Folder, "src", "extra.txt"), "x");

        Assert.NotNull(await Problem());
        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_FileRemoved_Rehashes()
    {
        await Problem();
        File.Delete(Path.Combine(Folder, "src", "lib", "main.txt"));

        Assert.NotNull(await Problem());
        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_FileReplacedWithSameSizeAndMtime_RehashesBecauseTheInodeChanged()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "the replacement keeps the same file index on this runner");
        await Problem();
        var file = Path.Combine(Folder, "src", "lib", "main.txt");
        var mtime = File.GetLastWriteTimeUtc(file);
        var stale = file + ".old";
        File.Move(file, stale);
        File.WriteAllText(file, "evil");
        File.SetLastWriteTimeUtc(file, mtime);
        File.Delete(stale);

        Assert.Contains("changed since approval", await Problem());
        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_CacheMissing_Rehashes()
    {
        await Problem();
        File.Delete(CachePath);

        Assert.Null(await Problem());
        Assert.Equal(2, _hashes);
    }

    [Theory]
    [InlineData("flip-byte")]
    [InlineData("truncate")]
    [InlineData("garbage")]
    public async Task ProblemAsync_TamperedOrUnreadableCache_IsRejectedAndRehashes(string how)
    {
        await Problem();
        var text = await File.ReadAllTextAsync(CachePath, TestContext.Current.CancellationToken);
        var tampered = how switch
        {
            "flip-byte" => FlipDigitAfterMiddle(text),
            "truncate" => text[..(text.Length / 2)],
            _ => "not json",
        };
        await File.WriteAllTextAsync(CachePath, tampered, TestContext.Current.CancellationToken);

        Assert.Null(await Problem());
        Assert.Equal(2, _hashes);
    }

    private static string FlipDigitAfterMiddle(string text)
    {
        var index = text.AsSpan(text.Length / 2).IndexOfAnyInRange('0', '9') + text.Length / 2;
        var chars = text.ToCharArray();
        chars[index] = chars[index] == '0' ? '1' : '0';
        return new string(chars);
    }

    [Fact]
    public async Task ProblemAsync_CacheAttestsAnotherTreeThanTheRecord_Rehashes()
    {
        await Problem();
        var newer = ApprovalFixture.WriteTree(Folder, ("lib/main.txt", "body2"));
        ApprovalFixture.WriteRecord(Folder, ApprovalFixture.Signed(Name, newer));

        Assert.Null(await Problem());
        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_LastFullHashOlderThanADay_Rehashes()
    {
        await Problem();
        _clock.Advance(TimeSpan.FromHours(23));
        await Problem();
        Assert.Equal(1, _hashes);

        _clock.Advance(TimeSpan.FromHours(2));
        await Problem();

        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_ClockRewoundBeforeTheLastFullHash_Rehashes()
    {
        await Problem();
        _clock.Set(Start.AddHours(-1));

        await Problem();

        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_AfterARehash_TheCacheIsFreshAgain()
    {
        await Problem();
        _clock.Advance(TimeSpan.FromHours(25));
        await Problem();
        await Problem();

        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_FailedHashCheck_WritesNoCache()
    {
        File.Delete(CachePath);
        File.WriteAllText(Path.Combine(Folder, "src", "lib", "main.txt"), "tampered");

        Assert.NotNull(await Problem());
        Assert.False(File.Exists(CachePath));
    }

    [Fact]
    public async Task ProblemAsync_StatCacheFile_IsNotPartOfTheTree()
    {
        await Problem();

        Assert.Equal(Tree, PluginApproval.HashTree(Path.Combine(Folder, "src")));
    }

    [Fact]
    public async Task ProblemAsync_UnsignedRecord_IsNotApprovedAndAsksToReapprove()
    {
        ApprovalFixture.WriteRecord(Folder, ApprovalFixture.Signed(Name, Tree) with { Mac = null });

        Assert.Contains("dg plugin verify scanner --approve", await Problem());
        Assert.Equal(0, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_BadMac_IsNotApproved()
    {
        ApprovalFixture.WriteRecord(Folder, ApprovalFixture.Signed(Name, Tree) with { Mac = new string('0', 64) });

        Assert.Contains("signature does not verify", await Problem());
    }

    [Fact]
    public async Task ProblemAsync_NeverApprovedRecord_DoesNotAskForTheKey()
    {
        ApprovalFixture.WriteRecord(Folder, ApprovalFixture.Signed(Name, Tree) with { ApprovedSha256 = null, Mac = null });

        Assert.Contains("review it", await Problem());
        Assert.Equal(0, _store.Reads);
    }

    [Fact]
    public async Task ProblemAsync_KeyAbsent_IsNotApprovedAndAsksToReapprove()
    {
        _store.Values.Clear();

        Assert.Contains("no approval key", await Problem());
    }

    [Fact]
    public async Task ProblemAsync_MalformedKey_IsTreatedAsAbsent()
    {
        _store.Values["dg/plugin-approval-key"] = "zz";

        Assert.Contains("no approval key", await Problem());
    }

    [Fact]
    public async Task ProblemAsync_StoreUnavailable_IsNotApprovedAndNamesTheDaemon()
    {
        _store.Failure = new IOException("dg daemon is not running");

        Assert.Contains("dg agent start", await Problem());
    }

    [Fact]
    public async Task ProblemAsync_ManyCalls_ReadTheKeyOnce()
    {
        for (var i = 0; i < 5; i++)
            await Problem();

        Assert.Equal(1, _store.Reads);
    }

    [Fact]
    public async Task ProblemAsync_CanceledToken_ReachesTheStoreAndThrows()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await _verifier.ProblemAsync(Name, Folder, cts.Token)
        );

        Assert.Equal(cts.Token, _store.LastToken);
    }

    [Fact]
    public async Task ProblemAsync_MissingSrcFolder_IsNotApproved()
    {
        Directory.Delete(Path.Combine(Folder, "src"), true);

        Assert.NotNull(await Problem());
    }

    [Fact]
    public async Task ProblemAsync_CachePathNotWritable_StillApproves()
    {
        Directory.CreateDirectory(CachePath);

        Assert.Null(await Problem());
    }
}

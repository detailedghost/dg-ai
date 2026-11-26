using Dg.Core.Plugins.Runtime;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class PluginApprovalVerifierTests : IDisposable
{
    private const string Name = "scanner";
    private static readonly DateTimeOffset Start = new(2026, 11, 25, 12, 0, 0, TimeSpan.Zero);
    private readonly TempFolder _temp = new();
    private readonly ManualClock _clock = new(Start);
    private readonly FakeApprovalSigner _signer = new();
    private readonly PluginApprovalVerifier _verifier;
    private int _hashes;

    public PluginApprovalVerifierTests()
    {
        _verifier = new PluginApprovalVerifier(
            _signer,
            _clock,
            src =>
            {
                _hashes++;
                return PluginApproval.HashTree(src);
            }
        );
        Folder = Path.Combine(_temp.Path, Name);
        Tree = ApprovalFixture.WriteTree(Folder, ("plugin.toml", "name = \"scanner\"\n"), ("lib/main.txt", "body"));
        ApprovalFixture.WriteRecord(Folder, ApprovalFixture.Signed(Name, Tree));
    }

    private string Folder { get; }

    private string Tree { get; }

    private string CachePath => Path.Combine(Folder, PluginStatCache.FileName);

    private ValueTask<string?> Problem() => _verifier.ProblemAsync(Name, Folder, CancellationToken.None);

    public void Dispose() => _temp.Dispose();

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
        var file = Path.Combine(Folder, "src", "lib", "main.txt");
        var stamp = File.GetLastWriteTimeUtc(file);
        var size = new FileInfo(file).Length;
        var newer = ApprovalFixture.WriteTree(Folder, ("lib/main.txt", new string('z', (int)size)));
        File.SetLastWriteTimeUtc(file, stamp);
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
    public async Task ProblemAsync_NeverApprovedRecord_DoesNotAskTheDaemon()
    {
        ApprovalFixture.WriteRecord(Folder, ApprovalFixture.Signed(Name, Tree) with { ApprovedSha256 = null, Mac = null });

        Assert.Contains("review it", await Problem());
        Assert.Equal(0, _signer.ApprovalVerifies);
    }

    [Fact]
    public async Task ProblemAsync_DaemonHoldsNoKey_IsNotApprovedAndAsksToReapprove()
    {
        _signer.Key = null;

        Assert.Contains("signature does not verify", await Problem());
    }

    [Fact]
    public async Task ProblemAsync_DaemonHoldsAnotherKey_IsNotApproved()
    {
        _signer.Key = Convert.FromHexString(new string('7', 64));

        Assert.Contains("signature does not verify", await Problem());
    }

    [Fact]
    public async Task ProblemAsync_DaemonUnavailable_IsNotApprovedAndNamesTheDaemon()
    {
        _signer.Failure = new IOException("dg daemon is not running");

        Assert.Contains("dg agent start", await Problem());
    }

    [Fact]
    public async Task ProblemAsync_SendsTheSevenSignedFieldsInOrder()
    {
        await Problem();

        Assert.Equal(
            ["scanner", "skill", "folder", "sha256", "pinned-value", Tree, Tree],
            _signer.LastApprovalFields!
        );
    }

    [Fact]
    public async Task ProblemAsync_NulInASignedField_IsNotApprovedWithoutAskingTheDaemon()
    {
        var file = Path.Combine(Folder, "dg-plugin.json");
        File.WriteAllText(file, File.ReadAllText(file).Replace("\"source\":\"folder\"", "\"source\":\"fol\\u0000der\""));

        Assert.Contains("NUL", await Problem());
        Assert.Equal(0, _signer.ApprovalVerifies);
    }

    [Fact]
    public async Task ProblemAsync_RecordWithAnExtraKey_IsNotApproved()
    {
        var file = Path.Combine(Folder, "dg-plugin.json");
        var text = await File.ReadAllTextAsync(file, TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(file, text.Replace("{\"name\"", "{\"extra\":1,\"name\""), TestContext.Current.CancellationToken);

        Assert.Contains("review it", await Problem());
    }

    [Fact]
    public async Task ProblemAsync_ManyCallsWithNothingChanged_VerifyTheStatCacheOnceEach()
    {
        for (var i = 0; i < 5; i++)
            await Problem();

        Assert.Equal(5, _signer.ApprovalVerifies);
        Assert.Equal(1, _signer.StatCacheSigns);
        Assert.Equal(4, _signer.StatCacheVerifies);
    }

    [Fact]
    public async Task ProblemAsync_StatCacheSignerDown_StillApprovesAfterAFullHash()
    {
        await Problem();
        var failing = new FailingStatCacheSigner(_signer);
        var verifier = new PluginApprovalVerifier(failing, _clock, src => { _hashes++; return PluginApproval.HashTree(src); });

        Assert.Null(await verifier.ProblemAsync(Name, Folder, CancellationToken.None));
        Assert.Equal(2, _hashes);
    }

    [Theory]
    [InlineData(long.MaxValue)]
    [InlineData(long.MinValue)]
    [InlineData(-62135596801000L)]
    public async Task ProblemAsync_StatCacheTimestampOutOfRange_HashesTheTreeAgain(long fullHashAtMs)
    {
        await Problem();
        var cache = File.ReadAllText(CachePath);
        var at = System.Text.RegularExpressions.Regex.Match(cache, "\"fullHashAtMs\":(-?\\d+)").Groups[1].Value;
        File.WriteAllText(CachePath, cache.Replace(at, fullHashAtMs.ToString(System.Globalization.CultureInfo.InvariantCulture)));

        Assert.Null(await Problem());
        Assert.Equal(2, _hashes);
    }

    [Fact]
    public async Task ProblemAsync_CanceledToken_ReachesTheSignerAndThrows()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await _verifier.ProblemAsync(Name, Folder, cts.Token)
        );

        Assert.Equal(cts.Token, _signer.LastToken);
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

    private sealed class FailingStatCacheSigner(FakeApprovalSigner inner) : IApprovalSigner
    {
        public ValueTask<bool> VerifyApprovalAsync(string[] fields, string mac, CancellationToken cancellationToken) =>
            inner.VerifyApprovalAsync(fields, mac, cancellationToken);

        public ValueTask<string> SignStatCacheAsync(string[] fields, CancellationToken cancellationToken) =>
            throw new IOException("daemon went away");

        public ValueTask<bool> VerifyStatCacheAsync(string[] fields, string mac, CancellationToken cancellationToken) =>
            throw new IOException("daemon went away");
    }
}

using System.Text;
using Dg.Core.Output;
using Dg.Hooks.Defs.Text;
using Dg.Hooks.Engine;

namespace Dg.Hooks.Tests.Text;

public sealed class TextParityTests
{
    public static TheoryData<string> SpellingNames => TextFixtureCase.Names("spelling");

    public static TheoryData<string> FormatNames => TextFixtureCase.Names("format");

    [Theory]
    [MemberData(nameof(SpellingNames))]
    public Task Spelling_Fixture_MatchesBunByteForByte(string name) => AssertMatchesBun(name);

    [Theory]
    [MemberData(nameof(FormatNames))]
    public Task Format_Fixture_MatchesBunByteForByte(string name) => AssertMatchesBun(name);

    [Fact]
    public void Fixtures_EveryCase_HasAllExpectedFiles()
    {
        foreach (var entry in TextFixtureCase.All.Where(c => c.Requires.Count == 0))
            foreach (var extension in new[] { "stdout", "stderr", "code", "files" })
                Assert.True(File.Exists(Path.Combine(TextFixtureCase.Directory, $"{entry.Name}.{extension}")), $"{entry.Name}.{extension}");
    }

    private static async Task AssertMatchesBun(string name)
    {
        var entry = TextFixtureCase.Get(name);
        Assert.SkipWhen(OperatingSystem.IsWindows(), "fixtures use POSIX shell formatters");
        Assert.SkipWhen(entry.KnownGap is not null, entry.KnownGap ?? "");
        Assert.SkipUnless(entry.Available(), $"requires {string.Join(", ", entry.Requires)}");

        var run = entry.Materialize();
        try
        {
            using MemoryStream stdout = new();
            using MemoryStream stderr = new();
            using StreamWriter engineError = new(stderr, new UTF8Encoding(false), 256, leaveOpen: true) { AutoFlush = true };
            TextHookIo io = new(run.Env, new OutputWriter(stdout), new OutputWriter(stderr));
            IHook hook = entry.Hook == "spelling" ? new SpellingHook(io) : new FormatHook(io);
            HookEngine engine = new([hook], engineError);

            var code = await engine.RunAsync(entry.Hook, [], new MemoryStream(run.Stdin), TestContext.Current.CancellationToken);

            string Norm(byte[] bytes) => Encoding.UTF8.GetString(bytes).Replace(run.Root, "<ROOT>", StringComparison.Ordinal);
            Assert.Equal(entry.Expected("stdout"), Norm(stdout.ToArray()));
            Assert.Equal(entry.Expected("stderr"), Norm(stderr.ToArray()));
            Assert.Equal(entry.Expected("code"), $"{code}\n");
            Assert.Equal(
                entry.Expected("files"),
                TextFixtureCase.Snapshot(run.Root).Replace(run.Root, "<ROOT>", StringComparison.Ordinal)
            );
        }
        finally
        {
            Directory.Delete(run.Root, recursive: true);
        }
    }
}

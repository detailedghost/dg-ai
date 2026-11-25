using Dg.Core.Paths;

namespace Dg.Core.Tests.Paths;

public sealed class PathFlavorTests
{
    private const int ResultOnlyCeilingBytes = 160;
    private const int ResolveCeilingBytes = 8192;
    private const int CaptureOverheadCeilingBytes = 8192;

    private static readonly PathFlavor Posix = PathFlavor.For(DgPlatform.Linux);
    private static readonly PathFlavor Win = PathFlavor.For(DgPlatform.Windows);

    [Theory]
    [InlineData("/home/u/./a/../.config//dg/config.toml", "/home/u/.config/dg/config.toml")]
    [InlineData("/..", "/")]
    [InlineData("/a/../../b", "/b")]
    [InlineData("a/../../b", "../b")]
    [InlineData("../../a", "../../a")]
    [InlineData("", ".")]
    [InlineData("./", ".")]
    [InlineData("a//b/", "a/b")]
    public void Normalize_Posix_CollapsesDotsAndSeparators(string input, string expected) =>
        Assert.Equal(expected, Posix.Normalize(input));

    [Theory]
    [InlineData("C:/Users/u/./x/../y", @"C:\Users\u\y")]
    [InlineData(@"C:\..\a", @"C:\a")]
    [InlineData("C:a/../b", "C:b")]
    [InlineData(@"\\server\share\..\x", @"\\server\x")]
    [InlineData("/a/b", @"\a\b")]
    [InlineData("..\\..\\a", @"..\..\a")]
    public void Normalize_Windows_UsesBackslashAndKeepsRoot(string input, string expected) =>
        Assert.Equal(expected, Win.Normalize(input));

    [Fact]
    public void Normalize_PathLongerThanStackBuffer_ResolvesDotSegments()
    {
        var segment = new string('q', 700);

        Assert.Equal($"/{segment}/x", Posix.Normalize($"/{segment}/../{segment}/./x"));
    }

    [Fact]
    public void Join_NoParts_ReturnsDot() => Assert.Equal(".", Posix.Join());

    [Fact]
    public void Join_PartsWithDotSegments_Normalizes() =>
        Assert.Equal("/h/z", Posix.Join("/h", ".", "..", "h", "z"));

    [Fact]
    public void Join_ThreeParts_AllocatesOnlyTheResult()
    {
        var bytes = AllocationProbe.BytesPerOp(() => Posix.Join("/home/u", ".config", "dg"));

        Assert.True(bytes <= ResultOnlyCeilingBytes, $"Join allocated {bytes} B/op");
    }

    [Fact]
    public void Normalize_DotSegments_AllocatesOnlyTheResult()
    {
        var bytes = AllocationProbe.BytesPerOp(() => Posix.Normalize("/home/u/./a/../.config//dg/config.toml"));

        Assert.True(bytes <= ResultOnlyCeilingBytes, $"Normalize allocated {bytes} B/op");
    }

    [Fact]
    public void Resolve_LinuxDefaults_StaysUnderPathBudget()
    {
        var seams = new DgPathSeams(DgPlatform.Linux, "/home/u", "/work", new Dictionary<string, string?>());

        var bytes = AllocationProbe.BytesPerOp(() => DgPaths.Resolve(seams));

        Assert.True(bytes <= ResolveCeilingBytes, $"DgPaths.Resolve allocated {bytes} B/op");
    }

    [Fact]
    public void Capture_AddsLittleBeyondTheEnvironmentTable()
    {
        var table = AllocationProbe.BytesPerOp(() => Environment.GetEnvironmentVariables());
        var capture = AllocationProbe.BytesPerOp(() => ProcessEnvironment.Capture());

        Assert.True(capture - table <= CaptureOverheadCeilingBytes, $"Capture added {capture - table} B/op over the environment table");
    }
}

using Dg.Hooks.Shared;

namespace Dg.Hooks.Tests.Shared;

public sealed class ManagedRootsTests
{
    private const UnixFileMode Private = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    [Fact]
    public void FileOwner_OfOwnTempDirectory_IsCurrentUser()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "no owner uid on Windows");
        using var temp = TempRoot.Create();

        Assert.Equal(FileOwner.CurrentUser, FileOwner.Of(temp.Path, follow: false));
    }

    [Fact]
    public void FileOwner_OfRootOwnedDirectory_IsZero()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "no owner uid on Windows");

        Assert.Equal(0u, FileOwner.Of("/", follow: false));
    }

    [Fact]
    public void AssertSafe_RootOwnedByAnotherUser_Throws()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows() || FileOwner.CurrentUser == 0, "needs a non-root POSIX user");

        var ex = Assert.Throws<InvalidOperationException>(() => ManagedRoots.AssertSafe("/usr", false));

        Assert.Equal("unsafe scratch/state directory: /usr", ex.Message);
    }

    [Fact]
    public void PrivateChild_ChildOwnedByAnotherUser_Throws()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows() || FileOwner.CurrentUser == 0, "needs a non-root POSIX user");
        using var temp = TempRoot.Create();
        var root = Path.Combine(temp.Path, "root");
        Directory.CreateDirectory(root, Private);
        Directory.CreateSymbolicLink(Path.Combine(root, "hooks"), "/usr");

        Assert.Throws<InvalidOperationException>(() => ManagedRoots.PrivateChild(root, "hooks", false));
    }

    [Fact]
    public void PrivateChild_FreshRoot_CreatesOwnerOnlyChild()
    {
        using var temp = TempRoot.Create();
        var root = Path.Combine(temp.Path, "root");

        var child = ManagedRoots.PrivateChild(root, "hooks", false);

        Assert.Equal(Path.Combine(root, "hooks"), child);
        Assert.True(Directory.Exists(child));
    }

    [Fact]
    public void AssertSafe_GroupWritableRoot_Throws()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "no unix modes on Windows");
        using var temp = TempRoot.Create();
        var root = Path.Combine(temp.Path, "root");
        Directory.CreateDirectory(root, Private | UnixFileMode.GroupWrite);
        File.SetUnixFileMode(root, Private | UnixFileMode.GroupWrite);

        Assert.Throws<InvalidOperationException>(() => ManagedRoots.AssertSafe(root, false));
    }

    [Fact]
    public void AssertSafe_RootIsLinkWithoutAllowance_Throws()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "symlinks need privileges on Windows");
        using var temp = TempRoot.Create();
        var target = Path.Combine(temp.Path, "target");
        Directory.CreateDirectory(target, Private);
        var link = Path.Combine(temp.Path, "link");
        Directory.CreateSymbolicLink(link, target);

        Assert.Throws<InvalidOperationException>(() => ManagedRoots.AssertSafe(link, false));
        ManagedRoots.AssertSafe(link, true);
    }
}

using Dg.Hooks.Defs.Repo;

namespace Dg.Hooks.Tests.Repo;

public sealed class GlobPatternTests
{
    [Theory]
    [InlineData("**/HANDOFF.md", ".agents/HANDOFF.md", true)]
    [InlineData("**/HANDOFF.md", ".agents/a/.b/HANDOFF.md", true)]
    [InlineData("**/HANDOFF.md", "HANDOFF.md", true)]
    [InlineData("**/HANDOFF.md", ".agents/HANDOFF.md.bak", false)]
    [InlineData(".agents/spec/**", ".agents/spec/x", true)]
    [InlineData(".agents/spec/**", ".agents/spec/.x/y", true)]
    [InlineData(".agents/spec/**", ".agents/spec", false)]
    [InlineData("bg/*.pid", "bg/x.pid", true)]
    [InlineData("bg/*.pid", "bg/.pid", true)]
    [InlineData("bg/*.pid", "bg/a/b.pid", false)]
    [InlineData("pw/log", "pw/log", true)]
    [InlineData("adhoc", "adhoc/x", false)]
    public void IsMatch_Pattern_MatchesBunGlob(string pattern, string path, bool expected) =>
        Assert.Equal(expected, GlobPattern.IsMatch(pattern, path));
}

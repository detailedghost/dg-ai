using Dg.Plugins;

namespace Dg.Plugins.Tests;

public sealed class HostSkillsTests : IDisposable
{
    private readonly string _home = Directory.CreateTempSubdirectory("dgskills").FullName;
    private readonly string _loaded;

    public HostSkillsTests()
    {
        _loaded = Path.Combine(_home, "loaded");
        Directory.CreateDirectory(Path.Combine(_loaded, "alpha"));
        File.WriteAllText(Path.Combine(_loaded, "alpha", "SKILL.md"), "alpha\n");
    }

    [Fact]
    public void Register_EmptyHomeAndRelativeConfigDirs_FallBackToTheHomeDirectory()
    {
        var env = new Dictionary<string, string?>
        {
            ["HOME"] = "",
            ["CLAUDE_CONFIG_DIR"] = "relative-claude",
            ["CODEX_HOME"] = "relative-codex",
        };

        new HostSkills(env, _home).Register("alpha-plugin", _loaded);

        Assert.True(File.Exists(Path.Combine(_home, ".claude", "skills", "alpha", "SKILL.md")));
        Assert.True(File.Exists(Path.Combine(_home, ".codex", "skills", "alpha", "SKILL.md")));
        Assert.False(Directory.Exists("relative-claude"));
        Assert.False(Directory.Exists("relative-codex"));
    }

    public void Dispose() => Directory.Delete(_home, recursive: true);
}

namespace Dg.Hooks.Tests;

internal sealed class GitEnvironment : IDisposable
{
    public const string Name = "git-environment";

    private readonly Dictionary<string, string?> _saved = [];

    private GitEnvironment() { }

    public static GitEnvironment Isolate()
    {
        var git = new GitEnvironment();
        git.Set("GIT_CONFIG_NOSYSTEM", "1");
        git.Set("GIT_CONFIG_GLOBAL", OperatingSystem.IsWindows() ? "NUL" : "/dev/null");
        git.Set("XDG_CONFIG_HOME", Path.Combine(Path.GetTempPath(), "dg-hooks-no-xdg"));
        git.Set("GIT_CEILING_DIRECTORIES", Path.TrimEndingDirectorySeparator(Path.GetTempPath()));
        return git;
    }

    public void Dispose()
    {
        foreach (var (name, value) in _saved)
            Environment.SetEnvironmentVariable(name, value);
    }

    private void Set(string name, string value)
    {
        _saved[name] = Environment.GetEnvironmentVariable(name);
        Environment.SetEnvironmentVariable(name, value);
    }
}

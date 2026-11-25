namespace Dg.Hooks.Shared;

public sealed class HookDirectories(Func<string, string?> env, string home)
{
    private const string HooksChild = "hooks";

    public static HookDirectories Process() =>
        new(Environment.GetEnvironmentVariable, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

    internal static HookDirectories For(IReadOnlyDictionary<string, string?> env) =>
        new(
            name => env.TryGetValue(name, out var value) ? value : null,
            env.TryGetValue("HOME", out var home) && !string.IsNullOrEmpty(home)
                ? home
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
        );

    public string Scratch() =>
        ManagedRoots.PrivateChild(ManagedRoots.Scratch(env), HooksChild, ManagedRoots.IsSet(env, "AI_SCRATCH_DIR"));

    public string State() =>
        ManagedRoots.PrivateChild(
            ManagedRoots.State(env, home),
            HooksChild,
            ManagedRoots.IsSet(env, "AI_STATE_DIR")
        );

    public void Verify()
    {
        Scratch();
        State();
    }
}

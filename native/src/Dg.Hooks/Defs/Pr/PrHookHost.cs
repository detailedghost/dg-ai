using Dg.Hooks.Shared;

namespace Dg.Hooks.Defs.Pr;

internal sealed class PrHookHost(
    IReadOnlyDictionary<string, string?>? env = null,
    TextWriter? output = null,
    TextWriter? error = null,
    string? cwd = null
)
{
    private HookEnvironment? _vars = env is null ? null : new HookEnvironment(env);
    private TextWriter? _output = output;
    private TextWriter? _error = error;

    private HookEnvironment Vars => _vars ??= HookEnvironment.Process();

    public string? Cwd => cwd;

    public IReadOnlyDictionary<string, string?> Env => Vars.Values;

    public TextWriter Output => _output ??= Console.Out;

    public TextWriter Error => _error ??= Console.Error;

    public string SessionOf(string? fromInput) => Vars.SessionOf(fromInput);

    public string MarkerSession() => Vars.MarkerSession();

    public string? Value(string name) => Vars.Value(name);

    public double Number(string name, double fallback) => Vars.Number(name, fallback);

    public string ScratchDirectory() => HookDirectories.For(Env).Scratch();
}

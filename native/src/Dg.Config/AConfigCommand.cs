using Dg.Core.Abstractions;
using Dg.Core.Config;
using Dg.Core.Errors;
using Dg.Core.Output;
using Dg.Core.Paths;

namespace Dg.Config;

public abstract class AConfigCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : ICommand
{
    protected IReadOnlyDictionary<string, string?> Env => env;

    protected OutputWriter Output => output;

    public abstract string Name { get; }

    public ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct)
    {
        var code = Run(args.ToArray());
        output.Flush();
        error.Flush();
        return ValueTask.FromResult(code);
    }

    protected abstract int Run(string[] args);

    protected int Fail(string message)
    {
        error.WriteLine($"dg: {message}");
        return 1;
    }

    protected int Fail(DgError failure) => Fail(ConfigErrorText.Render(failure));

    protected ConfigResult<ConfigLocation> Locate()
    {
        var seams = DgPathSeams.Current(env);
        var paths = DgPaths.Resolve(seams);
        if (!paths.IsOk)
            return ConfigResult<ConfigLocation>.Fail(paths.Error!);
        var home = env.TryGetValue("HOME", out var set) && set is not null ? set : seams.HomeDir;
        return ConfigResult<ConfigLocation>.Ok(new ConfigLocation(paths.Value!, home, seams));
    }

    protected static bool HasOption(string[] args)
    {
        foreach (var arg in args)
            if (arg.StartsWith('-'))
                return true;
        return false;
    }
}

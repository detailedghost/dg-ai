using System.Text;
using System.Text.Json;
using Dg.Core.Abstractions;
using Dg.Core.Output;
using Dg.Core.Paths;
using Dg.Core.Plugins.Contract;

namespace Dg.Plugins;

internal abstract class APluginCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : ICommand
{
    public abstract string Name { get; }

    public ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct)
    {
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        int code;
        try
        {
            code = Run(args.ToArray(), Open(), stdout, stderr);
        }
        catch (Exception ex)
            when (ex
                    is NotNativeException
                        or IOException
                        or UnauthorizedAccessException
                        or InvalidOperationException
                        or JsonException
                        or PluginContractException
            )
        {
            return ValueTask.FromResult(PluginsExit.NotNative);
        }
        output.Write(stdout.ToString());
        error.Write(stderr.ToString());
        output.Flush();
        error.Flush();
        return ValueTask.FromResult(code);
    }

    protected abstract int Run(string[] args, PluginStore store, StringBuilder stdout, StringBuilder stderr);

    protected static int Fail(StringBuilder stderr, string message)
    {
        stderr.Append("dg: ").Append(message).Append('\n');
        return 1;
    }

    private PluginStore Open()
    {
        var seams = DgPathSeams.Current(env);
        var paths = DgPaths.Resolve(seams);
        return paths.IsOk ? new PluginStore(paths.Value!, seams) : throw new NotNativeException();
    }
}

using Dg.Core.Output;
using Dg.Hooks.Shared;

namespace Dg.Hooks.Defs.Text;

internal sealed record TextHookIo(
    IReadOnlyDictionary<string, string?> Env,
    OutputWriter Out,
    OutputWriter Err
)
{
    public static TextHookIo Process() =>
        new(HookEnvironment.Process().Values, OutputWriter.Out, OutputWriter.Err);
}

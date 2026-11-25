using System.Collections;
using Dg.Core.Output;

namespace Dg.Hooks.Defs.Text;

internal sealed record TextHookIo(
    IReadOnlyDictionary<string, string?> Env,
    OutputWriter Out,
    OutputWriter Err
)
{
    public static TextHookIo Process()
    {
        Dictionary<string, string?> env = new(StringComparer.Ordinal);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            env[(string)entry.Key] = entry.Value as string;
        return new TextHookIo(env, OutputWriter.Out, OutputWriter.Err);
    }
}

using System.Collections;

namespace Dg.Cli;

internal static class EnvSnapshot
{
    public static Dictionary<string, string?> Capture()
    {
        var env = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            env[(string)entry.Key] = entry.Value as string;
        return env;
    }
}

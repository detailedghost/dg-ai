using System.Collections;

namespace Dg.Core.Paths;

public static class ProcessEnvironment
{
    public static Dictionary<string, string?> Capture()
    {
        var env = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            env[(string)entry.Key] = entry.Value as string;
        return env;
    }
}

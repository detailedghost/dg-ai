using System.Collections;

namespace Dg.Core.Paths;

public static class ProcessEnvironment
{
    public static Dictionary<string, string?> Capture()
    {
        var source = Environment.GetEnvironmentVariables();
        Dictionary<string, string?> env = new(source.Count, StringComparer.Ordinal);
        IDictionaryEnumerator entries = source.GetEnumerator();
        while (entries.MoveNext())
            env[(string)entries.Key] = entries.Value as string;
        return env;
    }
}

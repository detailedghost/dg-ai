using Dg.Core.Config;
using Dg.Core.Paths;

namespace Dg.Cli;

internal static class FrontGate
{
    public static bool IsNative(IReadOnlyDictionary<string, string?> env)
    {
        switch (env.GetValueOrDefault("DG_FRONT"))
        {
            case "0":
                return false;
            case "1":
                return true;
        }

        var paths = DgPaths.Resolve(DgPathSeams.Current(env));
        if (!paths.IsOk)
            return false;
        var file = paths.Value!.ConfigTomlPath;
        if (!File.Exists(file))
            return true;

        string text;
        try
        {
            text = File.ReadAllText(file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
        var loaded = DgConfig.Parse(text, file);
        return loaded.IsOk && loaded.Value!.FrontEnabled;
    }
}

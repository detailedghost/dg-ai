using Dg.Core.Config;
using Dg.Core.Paths;

namespace Dg.Cli;

internal readonly record struct FrontChoice(bool Native, DgToml? Toml)
{
    public static FrontChoice Core { get; } = new(false, null);
}

internal static class FrontGate
{
    public static FrontChoice Decide(IReadOnlyDictionary<string, string?> env)
    {
        switch (env.GetValueOrDefault("DG_FRONT"))
        {
            case "0":
                return FrontChoice.Core;
            case "1":
                return new FrontChoice(true, null);
        }

        var paths = DgPaths.Resolve(DgPathSeams.Current(env));
        if (!paths.IsOk)
            return FrontChoice.Core;
        var file = paths.Value!.ConfigTomlPath;
        if (!File.Exists(file))
            return new FrontChoice(true, null);

        string text;
        try
        {
            text = File.ReadAllText(file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return FrontChoice.Core;
        }
        var loaded = DgConfig.Parse(text, file);
        return loaded.IsOk ? new FrontChoice(loaded.Value!.FrontEnabled, loaded.Value) : FrontChoice.Core;
    }
}

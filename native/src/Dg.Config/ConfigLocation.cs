using Dg.Core.Paths;

namespace Dg.Config;

public sealed record ConfigLocation(DgPaths Paths, string HomeDir, DgPathSeams Seams)
{
    public string File => Paths.ConfigTomlPath;

    public bool Exists => System.IO.File.Exists(File);

    public bool HasLegacySources()
    {
        var inbox =
            Seams.Env.TryGetValue("EMAIL_ORGANIZER_HOME", out var home) && home is not null ? home
            : Seams.Env.TryGetValue("EMAIL_ORGANIZER_CONFIG_HOME", out var config) && config is not null ? config
            : Path.Combine(Paths.StateDir, "inbox", "config");
        string[] sources =
        [
            Paths.ConfigPath,
            Paths.CliOnlyMarker,
            Path.Combine(HomeDir, ".config", "browser-batch", "config.json"),
            Path.Combine(inbox, "organizer.config.json"),
            Path.Combine(Paths.ConfigDir, "ssms", "config.yaml"),
        ];
        foreach (var source in sources)
            if (System.IO.File.Exists(source))
                return true;
        return false;
    }

    public bool WaitsForMigration => !Exists && HasLegacySources();
}

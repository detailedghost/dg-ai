using Tomlyn.Model;

namespace Dg.Core.Config;

public enum PwMode
{
    Auto,
    Ext,
    Local,
}

public static class PwModes
{
    public static string Wire(this PwMode mode) =>
        mode switch
        {
            PwMode.Ext => "ext",
            PwMode.Local => "local",
            _ => "auto",
        };
}

public sealed record PluginEntry(
    bool Enabled,
    bool AllowRemote,
    bool FailClosed,
    string? Source,
    TomlTable Settings
);

public sealed record DgToml(
    PwMode PwMode,
    IReadOnlyList<string> PwPhiSites,
    bool FrontEnabled,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> Hooks,
    bool InstallCliOnly,
    string? RefsDefaultRepo,
    IReadOnlyDictionary<string, string> RefsAliases,
    TomlTable Inbox,
    TomlTable Ssms,
    IReadOnlyDictionary<string, PluginEntry> Plugins,
    IReadOnlyDictionary<string, string> MetaMigrated
);

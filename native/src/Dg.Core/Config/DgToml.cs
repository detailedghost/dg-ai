using Tomlyn.Model;

namespace Dg.Core.Config;

public enum BrowserMode
{
    Auto,
    Ext,
    Local,
}

public static class BrowserModes
{
    public static string Wire(this BrowserMode mode) =>
        mode switch
        {
            BrowserMode.Ext => "ext",
            BrowserMode.Local => "local",
            _ => "auto",
        };
}

public sealed record PluginEntry(
    bool Enabled,
    bool AllowRemote,
    string? Source,
    TomlTable Settings
);

public sealed record DgToml(
    BrowserMode BrowserMode,
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

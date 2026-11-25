using Dg.Core.Paths;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Tcp;

namespace Dg.Core.Plugins.Runtime;

public sealed class PluginManifestStore(DgPaths paths) : ITcpManifestResolver
{
    private const string ManifestFile = "plugin.toml";

    public string Folder(string name)
    {
        if (!PluginNames.IsValid(name))
            throw new PluginContractException(
                PluginRuntimeCodes.BadName,
                $"dg plugin: {name} is not a plugin name. Next: use lowercase letters, digits and hyphens, starting with a letter."
            );
        return Path.Combine(paths.DataDir, "plugins", name);
    }

    public PluginManifest? TryLoad(string name)
    {
        var file = Path.Combine(Folder(name), "src", ManifestFile);
        return File.Exists(file) ? ManifestParser.Parse(File.ReadAllText(file), file) : null;
    }

    public PluginManifest Manifest(string plugin) =>
        TryLoad(plugin)
        ?? throw new PluginContractException(
            PluginRuntimeCodes.NotInstalled,
            $"dg plugin: {plugin} is not installed. Next: run dg plugin list, or dg plugin add <source>."
        );
}

public static class PluginRuntimeCodes
{
    public const string BadName = "bad-name";
    public const string NotInstalled = "not-installed";
    public const string Disabled = "plugin-disabled";
    public const string Unapproved = "plugin-unapproved";
    public const string EventsOnly = "udp-events-only";
    public const string BadReply = "bad-reply";
}

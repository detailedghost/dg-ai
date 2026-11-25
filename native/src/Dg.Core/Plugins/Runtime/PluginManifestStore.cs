using System.Text.RegularExpressions;
using Dg.Core.Paths;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;
using Dg.Core.Transport.Tcp;

namespace Dg.Core.Plugins.Runtime;

public sealed partial class PluginManifestStore(DgPaths paths) : ITcpManifestResolver
{
    private const string ManifestFile = "plugin.toml";

    [GeneratedRegex(@"^[a-z][a-z0-9-]{0,63}\z")]
    private static partial Regex NamePattern();

    public string Folder(string name)
    {
        if (!NamePattern().IsMatch(name))
            throw new PluginContractException(
                PluginRuntimeCodes.BadName,
                $"dg plugin: {name} is not a plugin name. Next: use lowercase letters, digits and hyphens, starting with a letter."
            );
        return Path.Combine(paths.DataDir, "plugins", name);
    }

    public PluginManifest? TryLoad(string name)
    {
        var folder = Folder(name);
        foreach (var file in new[] { Path.Combine(folder, ManifestFile), Path.Combine(folder, "src", ManifestFile) })
            if (File.Exists(file))
                return ManifestParser.Parse(File.ReadAllText(file), file);
        return null;
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

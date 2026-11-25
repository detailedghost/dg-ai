namespace Dg.Core.Plugins.Manifest;

public sealed record PermissionReport(IReadOnlyList<string> Enforced, IReadOnlyList<string> Unenforced)
{
    public static PermissionReport For(PluginManifest manifest)
    {
        if (manifest.Entry.IsBuiltin)
            return new([], []);
        var (capabilities, permissions) = (manifest.Capabilities, manifest.Permissions);
        return new(
            [
                $"exec allowlist: {Listed(capabilities.Exec)}",
                $"credentials: {Listed(permissions.Credentials)}",
                $"environment: {Listed(permissions.Env)}",
                "working directory: the plugin folder",
                "timeouts: per route",
            ],
            [
                $"network access: {(capabilities.Network ? "declared" : "not declared")}",
                $"file read: {Listed(capabilities.FsRead)}",
                $"file write: {Listed(capabilities.FsWrite)}",
            ]
        );
    }

    private static string Listed(string[] values) => values.Length == 0 ? "none" : string.Join(", ", values);
}

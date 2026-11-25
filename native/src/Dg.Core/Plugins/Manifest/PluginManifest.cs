using Dg.Core.Abstractions;

namespace Dg.Core.Plugins.Manifest;

public enum PluginTransportKind
{
    Ipc,
    Http,
    Tcp,
    Udp,
}

public enum PluginPinKind
{
    Sha256,
    Commit,
}

public sealed record PluginPin(PluginPinKind Kind, string Value);

public sealed record PluginEntry(string? Builtin, string? Command, string[] Args)
{
    public bool IsBuiltin => Builtin is not null;
}

public sealed record PluginCapabilities(bool Network, string[] FsRead, string[] FsWrite, string[] Exec);

public sealed record PluginPermissions(string[] Credentials, string[] Env);

public sealed record PluginManifest(
    string Name,
    string Version,
    PluginKind Kind,
    PluginTransportKind Transport,
    string? Endpoint,
    bool Remote,
    string? Source,
    PluginPin? Pin,
    PluginEntry Entry,
    PluginCapabilities Capabilities,
    PluginPermissions Permissions
);

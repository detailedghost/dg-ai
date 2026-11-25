namespace Dg.Core.Plugins.Manifest;

internal static class IpcEndpoint
{
    public static bool IsBareFileName(string endpoint) =>
        endpoint.Length > 0
        && endpoint is not ("." or "..")
        && endpoint.IndexOfAny(['/', '\\', '\0']) < 0
        && !Path.IsPathRooted(endpoint);
}

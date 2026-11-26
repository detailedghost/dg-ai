using System.Text.RegularExpressions;

namespace Dg.Core.Plugins.Manifest;

public static partial class PluginNames
{
    [GeneratedRegex(@"^[a-z][a-z0-9-]{0,63}\z")]
    private static partial Regex Pattern();

    public static bool IsValid(string name) => Pattern().IsMatch(name);
}

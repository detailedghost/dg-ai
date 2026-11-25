using System.Text.Json;

namespace Dg.Core.Tests.Plugins;

internal static class PluginFixtures
{
    private static readonly string Root = FindRoot();

    public static string Path(params string[] parts) => System.IO.Path.Combine([Root, .. parts]);

    public static string ReadText(params string[] parts) => File.ReadAllText(Path(parts));

    public static JsonDocument ReadJson(params string[] parts) => JsonDocument.Parse(ReadText(parts));

    public static IEnumerable<string> Files(string folder, string pattern) =>
        Directory
            .EnumerateFiles(Path(folder), pattern)
            .Select(System.IO.Path.GetFileName)
            .Order(StringComparer.Ordinal)!;

    private static string FindRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = System.IO.Path.Combine(dir.FullName, "pkg", "common", "fixtures", "plugins");
            if (Directory.Exists(candidate))
                return candidate;
        }
        throw new DirectoryNotFoundException("pkg/common/fixtures/plugins not found above the test assembly");
    }
}

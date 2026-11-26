using System.Runtime.CompilerServices;

namespace Dg.Core.Tests.Config;

internal static class FixtureFiles
{
    public static string Directory { get; } = Path.Combine(Folder(), "fixtures");

    public static string Read(string name) => File.ReadAllText(Path.Combine(Directory, name));

    public static TheoryData<string> Names(string prefix)
    {
        var data = new TheoryData<string>();
        foreach (var file in System.IO.Directory.GetFiles(Directory, $"{prefix}*.toml").Order())
            data.Add(Path.GetFileNameWithoutExtension(file));
        return data;
    }

    private static string Folder([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}

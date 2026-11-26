using Dg.Hooks.Shared;

namespace Dg.Hooks.Tests;

internal sealed class TempRoot : IDisposable
{
    private TempRoot(string path) => Path = path;

    public string Path { get; }

    public static TempRoot Create() =>
        new(FsPaths.RealPath(Directory.CreateTempSubdirectory("dg-hooks-shared-").FullName));

    public void Dispose()
    {
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(Path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        else
            foreach (var file in Directory.EnumerateFiles(Path, "*", SearchOption.AllDirectories))
                File.SetAttributes(file, FileAttributes.Normal);
        Directory.Delete(Path, recursive: true);
    }
}

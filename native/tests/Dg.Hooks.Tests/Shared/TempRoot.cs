namespace Dg.Hooks.Tests;

internal sealed class TempRoot : IDisposable
{
    private TempRoot(string path) => Path = path;

    public string Path { get; }

    public static TempRoot Create() =>
        new(FsRealPath(Directory.CreateTempSubdirectory("dg-hooks-shared-").FullName));

    public void Dispose()
    {
        File.SetUnixFileMode(Path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        Directory.Delete(Path, recursive: true);
    }

    private static string FsRealPath(string path) => Directory.ResolveLinkTarget(path, true)?.FullName ?? path;
}

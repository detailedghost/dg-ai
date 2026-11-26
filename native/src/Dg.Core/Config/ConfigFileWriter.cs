using System.Text;

namespace Dg.Core.Config;

public static class ConfigFileWriter
{
    private const UnixFileMode OwnerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite;

    public static void Write(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var target = File.Exists(path) ? new FileInfo(path).ResolveLinkTarget(true)?.FullName ?? path : path;
        var mode = OperatingSystem.IsWindows() ? OwnerOnly : File.Exists(target) ? File.GetUnixFileMode(target) : OwnerOnly;
        var temp = $"{target}.{Environment.ProcessId}.tmp";
        try
        {
            using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(temp, mode);
                stream.Write(new UTF8Encoding(false).GetBytes(text));
                stream.Flush(true);
            }
            File.Move(temp, target, overwrite: true);
        }
        finally
        {
            File.Delete(temp);
        }
    }
}

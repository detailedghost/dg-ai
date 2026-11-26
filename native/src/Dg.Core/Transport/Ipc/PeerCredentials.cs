using System.Net.Sockets;
using System.Runtime.InteropServices;
using Dg.Core.Errors;

namespace Dg.Core.Transport.Ipc;

internal static partial class PeerCredentials
{
    private const int LinuxSolSocket = 1;
    private const int LinuxSoPeerCred = 17;
    private const int MacSolLocal = 0;
    private const int MacLocalPeerCred = 1;

    [LibraryImport("libc", EntryPoint = "geteuid")]
    private static partial uint GetEffectiveUserId();

    public static void VerifySocketFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists)
            throw Fail(path, "socket file not found", "start the plugin, then retry");
        if (info.LinkTarget is not null)
            throw Fail(path, "socket path is a symbolic link", "point the plugin endpoint at the socket file itself");
        var mode = info.UnixFileMode;
        if ((mode & (
                UnixFileMode.GroupRead
                | UnixFileMode.GroupWrite
                | UnixFileMode.GroupExecute
                | UnixFileMode.OtherRead
                | UnixFileMode.OtherWrite
                | UnixFileMode.OtherExecute
            )) != 0)
            throw Fail(
                path,
                $"permissions are 0{Convert.ToString((int)mode, 8)}, the limit is 0600",
                $"run chmod 600 {path} or fix the plugin's umask"
            );
    }

    public static void VerifyPeer(Socket socket, string path)
    {
        Span<byte> buffer = stackalloc byte[128];
        uint peer;
        if (OperatingSystem.IsLinux())
        {
            if (socket.GetRawSocketOption(LinuxSolSocket, LinuxSoPeerCred, buffer) < 12)
                throw Fail(path, "peer credentials are unavailable", "run the plugin as your own user");
            peer = BitConverter.ToUInt32(buffer[4..8]);
        }
        else if (OperatingSystem.IsMacOS())
        {
            if (socket.GetRawSocketOption(MacSolLocal, MacLocalPeerCred, buffer) < 8)
                throw Fail(path, "peer credentials are unavailable", "run the plugin as your own user");
            peer = BitConverter.ToUInt32(buffer[4..8]);
        }
        else
        {
            throw Fail(path, "peer credentials are not supported on this OS", "use the http transport");
        }

        var self = GetEffectiveUserId();
        if (peer != self)
            throw Fail(path, $"socket is served by uid {peer}, not uid {self}", "run only plugins you own");
    }

    private static DgException Fail(string path, string message, string next) =>
        new DgError(path, null, "ipc-insecure", message, next).ToException();
}

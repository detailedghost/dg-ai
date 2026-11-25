using System.Runtime.InteropServices;
using System.Text;

namespace Dg.Hooks.Shared;

internal static class FileOwner
{
    private const int LinuxAtFdCwd = -100;
    private const int LinuxAtSymlinkNofollow = 0x100;
    private const uint LinuxStatxUid = 0x8;
    private const int LinuxStatxUidOffset = 20;
    private const int MacUidOffset = 16;
    private const int BufferSize = 512;

    public static uint? CurrentUser => OperatingSystem.IsWindows() ? null : GetUserId();

    public static uint Of(string path, bool follow)
    {
        Span<byte> name = Encoding.UTF8.GetBytes(path + "\0");
        Span<byte> buffer = stackalloc byte[BufferSize];
        ref var pathRef = ref MemoryMarshal.GetReference(name);
        ref var bufferRef = ref MemoryMarshal.GetReference(buffer);
        if (OperatingSystem.IsLinux())
        {
            if (Statx(LinuxAtFdCwd, ref pathRef, follow ? 0 : LinuxAtSymlinkNofollow, LinuxStatxUid, ref bufferRef) != 0)
                throw new IOException($"cannot stat {path}");
            return BitConverter.ToUInt32(buffer[LinuxStatxUidOffset..]);
        }
        var status = follow switch
        {
            true when RuntimeInformation.ProcessArchitecture == Architecture.X64 => MacStatX64(ref pathRef, ref bufferRef),
            false when RuntimeInformation.ProcessArchitecture == Architecture.X64 => MacLstatX64(ref pathRef, ref bufferRef),
            true => MacStat(ref pathRef, ref bufferRef),
            false => MacLstat(ref pathRef, ref bufferRef),
        };
        if (status != 0)
            throw new IOException($"cannot stat {path}");
        return BitConverter.ToUInt32(buffer[MacUidOffset..]);
    }

    [DllImport("libc", EntryPoint = "getuid")]
    private static extern uint GetUserId();

    [DllImport("libc", EntryPoint = "statx")]
    private static extern int Statx(int dirFd, ref byte path, int flags, uint mask, ref byte buffer);

    [DllImport("libc", EntryPoint = "stat")]
    private static extern int MacStat(ref byte path, ref byte buffer);

    [DllImport("libc", EntryPoint = "lstat")]
    private static extern int MacLstat(ref byte path, ref byte buffer);

    [DllImport("libc", EntryPoint = "stat$INODE64")]
    private static extern int MacStatX64(ref byte path, ref byte buffer);

    [DllImport("libc", EntryPoint = "lstat$INODE64")]
    private static extern int MacLstatX64(ref byte path, ref byte buffer);
}

using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Dg.Core.Plugins.Runtime;

internal static partial class FileIdentity
{
    private const int LinuxAtFdCwd = -100;
    private const int LinuxAtSymlinkNofollow = 0x100;
    private const uint LinuxStatxIno = 0x100;
    private const int LinuxStatxInoOffset = 32;
    private const int MacInoOffset = 8;
    private const int BufferSize = 512;
    private const int NameStackLimit = 1024;

    public static ulong Of(string path)
    {
        try
        {
            if (OperatingSystem.IsWindows())
                return WindowsIndex(path);
            return OperatingSystem.IsLinux() ? LinuxInode(path) : MacInode(path);
        }
        catch (Exception ex)
            when (ex is DllNotFoundException
                    or EntryPointNotFoundException
                    or BadImageFormatException
                    or IOException
                    or UnauthorizedAccessException
            )
        {
            return 0;
        }
    }

    private static ulong LinuxInode(string path)
    {
        var max = Encoding.UTF8.GetMaxByteCount(path.Length) + 1;
        Span<byte> name = max <= NameStackLimit ? stackalloc byte[max] : new byte[max];
        name[Encoding.UTF8.GetBytes(path, name)] = 0;
        Span<byte> buffer = stackalloc byte[BufferSize];
        ref var nameRef = ref MemoryMarshal.GetReference(name);
        ref var bufferRef = ref MemoryMarshal.GetReference(buffer);
        if (Statx(LinuxAtFdCwd, ref nameRef, LinuxAtSymlinkNofollow, LinuxStatxIno, ref bufferRef) != 0)
            return 0;
        return (BinaryPrimitives.ReadUInt32LittleEndian(buffer) & LinuxStatxIno) == 0
            ? 0
            : BinaryPrimitives.ReadUInt64LittleEndian(buffer[LinuxStatxInoOffset..]);
    }

    private static ulong MacInode(string path)
    {
        var max = Encoding.UTF8.GetMaxByteCount(path.Length) + 1;
        Span<byte> name = max <= NameStackLimit ? stackalloc byte[max] : new byte[max];
        name[Encoding.UTF8.GetBytes(path, name)] = 0;
        Span<byte> buffer = stackalloc byte[BufferSize];
        ref var nameRef = ref MemoryMarshal.GetReference(name);
        ref var bufferRef = ref MemoryMarshal.GetReference(buffer);
        var status =
            RuntimeInformation.ProcessArchitecture == Architecture.X64
                ? MacLstatX64(ref nameRef, ref bufferRef)
                : MacLstat(ref nameRef, ref bufferRef);
        return status == 0 ? BinaryPrimitives.ReadUInt64LittleEndian(buffer[MacInoOffset..]) : 0;
    }

    private static ulong WindowsIndex(string path)
    {
        using var handle = File.OpenHandle(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete
        );
        return GetFileInformationByHandle(handle, out var info)
            ? ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow
            : 0;
    }

    [LibraryImport("libc", EntryPoint = "statx")]
    private static partial int Statx(int dirFd, ref byte path, int flags, uint mask, ref byte buffer);

    [LibraryImport("libc", EntryPoint = "lstat")]
    private static partial int MacLstat(ref byte path, ref byte buffer);

    [LibraryImport("libc", EntryPoint = "lstat$INODE64")]
    private static partial int MacLstatX64(ref byte path, ref byte buffer);

    [LibraryImport("kernel32.dll", EntryPoint = "GetFileInformationByHandle")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public uint CreationTimeLow;
        public uint CreationTimeHigh;
        public uint LastAccessTimeLow;
        public uint LastAccessTimeHigh;
        public uint LastWriteTimeLow;
        public uint LastWriteTimeHigh;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }
}

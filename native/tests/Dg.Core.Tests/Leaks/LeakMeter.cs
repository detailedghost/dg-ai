using System.Diagnostics;
using System.Runtime.CompilerServices;

namespace Dg.Core.Tests.Leaks;

internal readonly record struct LeakReport(
    double BytesPerIteration,
    int OpenFilesGrowth,
    int ThreadGrowth,
    long FirstBatchBytes,
    long LastBatchBytes
);

internal static class LeakMeter
{
    public static async Task<LeakReport> MeasureAsync(
        Func<Task> iteration,
        int batches = 5,
        int perBatch = 2_000,
        int warmup = 200
    )
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(batches, 2);
        for (var i = 0; i < warmup; i++)
            await iteration();
        Settle();
        var files = OpenFiles();
        var threads = ThreadPool.ThreadCount;
        var samples = new long[batches];
        for (var b = 0; b < batches; b++)
        {
            for (var i = 0; i < perBatch; i++)
                await iteration();
            Settle();
            samples[b] = GC.GetTotalMemory(true);
        }
        var slope = (double)(samples[^1] - samples[0]) / ((batches - 1) * perBatch);
        return new LeakReport(slope, OpenFiles() - files, ThreadPool.ThreadCount - threads, samples[0], samples[^1]);
    }

    public static int OpenFiles()
    {
        if (OperatingSystem.IsLinux())
            return Directory.GetFileSystemEntries("/proc/self/fd").Length;
        if (OperatingSystem.IsMacOS())
            return Directory.GetFileSystemEntries("/dev/fd").Length;
        using var process = Process.GetCurrentProcess();
        return process.HandleCount;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Settle()
    {
        for (var i = 0; i < 3; i++)
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
        }
    }
}

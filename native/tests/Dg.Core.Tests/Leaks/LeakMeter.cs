using System.Runtime.CompilerServices;

namespace Dg.Core.Tests.Leaks;

internal readonly record struct LeakReport(double BytesPerIteration, int OpenFilesGrowth, int ThreadGrowth, long FirstBatchBytes, long LastBatchBytes);

internal static class LeakMeter
{
    public static async Task<LeakReport> MeasureAsync(Func<Task> iteration, int batches = 5, int perBatch = 2_000, int warmup = 200)
    {
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

    public static async Task<long> AllocatedPerIterationAsync(Func<Task> iteration, int count = 20_000, int warmup = 500)
    {
        for (var i = 0; i < warmup; i++)
            await iteration();
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < count; i++)
            await iteration();
        return (GC.GetAllocatedBytesForCurrentThread() - before) / count;
    }

    public static long AllocatedPerIteration(Action iteration, int count = 100_000, int warmup = 1_000)
    {
        for (var i = 0; i < warmup; i++)
            iteration();
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < count; i++)
            iteration();
        return (GC.GetAllocatedBytesForCurrentThread() - before) / count;
    }

    public static int OpenFiles() =>
        OperatingSystem.IsLinux() ? Directory.GetFileSystemEntries("/proc/self/fd").Length : 0;

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

using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;

namespace Dg.Core.Tests.Leaks;

internal readonly record struct LeakReport(
    double BytesPerIteration,
    int OpenFilesGrowth,
    int ThreadGrowth,
    BatchSample[] Batches
)
{
    public string Describe()
    {
        var text = new StringBuilder();
        text.Append(
            CultureInfo.InvariantCulture,
            $"slope={BytesPerIteration:F1} B/call, files+{OpenFilesGrowth}, threads+{ThreadGrowth}"
        );
        for (var i = 0; i < Batches.Length; i++)
            text.Append('\n').Append(CultureInfo.InvariantCulture, $"batch {i}: {Batches[i]}");
        return text.ToString();
    }
}

internal readonly record struct BatchSample(
    long HeapBytes,
    int Gen0,
    int Gen1,
    int Gen2,
    long GcHeapSizeBytes,
    long GcCommittedBytes,
    long AllocatedBytesPerCall
)
{
    public override string ToString() =>
        $"heap={HeapBytes} gc0={Gen0} gc1={Gen1} gc2={Gen2} "
        + $"heapSize={GcHeapSizeBytes} committed={GcCommittedBytes} alloc/call={AllocatedBytesPerCall}";
}

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
        var samples = new BatchSample[batches];
        for (var b = 0; b < batches; b++)
        {
            var gen0 = GC.CollectionCount(0);
            var gen1 = GC.CollectionCount(1);
            var gen2 = GC.CollectionCount(2);
            var allocated = GC.GetTotalAllocatedBytes(precise: true);
            for (var i = 0; i < perBatch; i++)
                await iteration();
            var perCall = (GC.GetTotalAllocatedBytes(precise: true) - allocated) / perBatch;
            var batchGen0 = GC.CollectionCount(0) - gen0;
            var batchGen1 = GC.CollectionCount(1) - gen1;
            var batchGen2 = GC.CollectionCount(2) - gen2;
            Settle();
            var heap = GC.GetTotalMemory(true);
            var info = GC.GetGCMemoryInfo();
            samples[b] = new BatchSample(
                heap,
                batchGen0,
                batchGen1,
                batchGen2,
                info.HeapSizeBytes,
                info.TotalCommittedBytes,
                perCall
            );
        }
        var slope = (double)(samples[^1].HeapBytes - samples[0].HeapBytes) / ((batches - 1) * perBatch);
        return new LeakReport(
            slope,
            OpenFiles() - files,
            ThreadPool.ThreadCount - threads,
            samples
        );
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

namespace Dg.Tests.Shared;

internal static class AllocationProbe
{
    public static double BytesPerOp(Action operation, int iterations = 500, int warmup = 50)
    {
        for (var i = 0; i < warmup; i++)
            operation();
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < iterations; i++)
            operation();
        return (double)(GC.GetAllocatedBytesForCurrentThread() - before) / iterations;
    }

    public static double TotalBytesPerOp(Action operation, int iterations = 500, int warmup = 50)
    {
        for (var i = 0; i < warmup; i++)
            operation();
        var before = GC.GetTotalAllocatedBytes(precise: true);
        for (var i = 0; i < iterations; i++)
            operation();
        return (double)(GC.GetTotalAllocatedBytes(precise: true) - before) / iterations;
    }
}

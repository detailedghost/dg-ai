namespace Dg.Tests.Shared;

internal static class AllocationProbe
{
    public static long BytesPerOp(Action operation, int iterations = 500)
    {
        for (var i = 0; i < 50; i++)
            operation();
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < iterations; i++)
            operation();
        return (GC.GetAllocatedBytesForCurrentThread() - before) / iterations;
    }
}

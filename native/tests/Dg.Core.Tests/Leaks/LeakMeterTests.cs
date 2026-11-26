namespace Dg.Core.Tests.Leaks;

[Collection(LeakCollection.Name)]
public sealed class LeakMeterTests
{
    [Fact]
    public async Task MeasureAsync_Batches_ReportsEveryBatchWithGcAndAllocationData()
    {
        var report = await LeakMeter.MeasureAsync(() => Task.FromResult(new byte[64]), batches: 3, perBatch: 50, warmup: 10);

        Assert.Equal(3, report.Batches.Length);
        Assert.All(report.Batches, batch => Assert.True(batch.HeapBytes > 0 && batch.AllocatedBytesPerCall >= 64));
        var lines = report.Describe().Split('\n');
        Assert.Equal(3, lines.Count(line => line.StartsWith("batch ")));
        Assert.Contains("gc0=", report.Describe());
        Assert.Contains("gc1=", report.Describe());
        Assert.Contains("gc2=", report.Describe());
        Assert.Contains("heapSize=", report.Describe());
        Assert.Contains("alloc/call=", report.Describe());
    }
}

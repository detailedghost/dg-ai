namespace Dg.Core.Tests.Leaks;

[Collection(LeakCollection.Name)]
public sealed class LeakMeterTests
{
    [Fact]
    public async Task MeasureAsync_Batches_ReportsEveryBatchWithGcAndAllocationData()
    {
        var report = await LeakMeter.MeasureAsync(() => Task.FromResult(new byte[64]), batches: 3, perBatch: 50, warmup: 10);

        Assert.Equal(3, report.Batches.Length);
        Assert.All(report.Batches, batch => Assert.True(batch.HeapBytes > 0, batch.ToString()));
        Assert.All(report.Batches, batch => Assert.True(batch.AllocatedBytesPerCall >= 64, batch.ToString()));
        var described = report.Describe();
        Assert.Equal(3, described.Split('\n').Count(line => line.StartsWith("batch ")));
        Assert.Contains("gc0=", described);
        Assert.Contains("gc1=", described);
        Assert.Contains("gc2=", described);
        Assert.Contains("heapSize=", described);
        Assert.Contains("alloc/call=", described);
    }
}

using System.Diagnostics;

namespace Dg.Bench;

internal static class Stats
{
    public static CaseResult Summarize(string name, long[] ticks)
    {
        Array.Sort(ticks);
        return new(name, ticks.Length, ToMs(Percentile(ticks, 0.50)), ToMs(Percentile(ticks, 0.99)));
    }

    public static async Task<CaseResult> MeasureAsync(string name, int warmup, int samples, Func<ValueTask> operation)
    {
        for (var i = 0; i < warmup; i++)
            await operation().ConfigureAwait(false);
        var ticks = new long[samples];
        for (var i = 0; i < samples; i++)
        {
            var start = Stopwatch.GetTimestamp();
            await operation().ConfigureAwait(false);
            ticks[i] = Stopwatch.GetTimestamp() - start;
        }
        return Summarize(name, ticks);
    }

    private static long Percentile(long[] sorted, double fraction) =>
        sorted[Math.Min(sorted.Length - 1, (int)Math.Ceiling(sorted.Length * fraction) - 1)];

    private static double ToMs(long ticks) => Math.Round(ticks * 1000.0 / Stopwatch.Frequency, 6);
}

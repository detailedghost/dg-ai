using System.Text.Json;
using Dg.Bench;

if (args is ["--child", var transport, var endpoint])
    return await Child.RunAsync(transport, endpoint);

if (args is ["--gate", var budgetPath, "--from", var reportPath])
    return Gate.Run(budgetPath, reportPath);

var report = await Runner.RunAsync(CancellationToken.None);
foreach (var result in report.Cases)
    Console.Error.WriteLine($"{result.Name,-20} p50 {result.P50Ms:0.000000} ms  p99 {result.P99Ms:0.000000} ms  n={result.Samples}");

var json = JsonSerializer.Serialize(report, BenchJsonContext.Default.BenchReport);
if (args is ["--out", var outPath])
    File.WriteAllText(outPath, json + "\n");
else
    Console.Out.WriteLine(json);
return 0;

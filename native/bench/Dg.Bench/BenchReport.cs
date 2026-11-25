using System.Text.Json.Serialization;

namespace Dg.Bench;

public sealed record CaseResult(string Name, int Samples, double P50Ms, double P99Ms);

public sealed record BenchReport(
    string Rid,
    double IpcWarmP50Ms,
    double HttpWarmP50Ms,
    double IpcFreshProcessMs,
    double HttpFreshProcessMs,
    IReadOnlyList<CaseResult> Cases
);

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    WriteIndented = true,
    NumberHandling = JsonNumberHandling.Strict
)]
[JsonSerializable(typeof(BenchReport))]
internal sealed partial class BenchJsonContext : JsonSerializerContext;

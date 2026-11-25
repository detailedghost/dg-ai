using System.Globalization;
using System.Text.Json;

namespace Dg.Bench;

internal static class Gate
{
    private static readonly (string Key, string Label)[] Gated =
    [
        ("ipcWarmP50Ms", "IPC warm p50"),
        ("httpWarmP50Ms", "HTTP warm p50"),
        ("ipcFreshProcessMs", "IPC fresh-process hook p50"),
        ("httpFreshProcessMs", "HTTP fresh-process hook p50"),
    ];

    public static int Run(string budgetPath, string reportPath)
    {
        var budgets = ReadNumbers(budgetPath);
        var measured = ReadNumbers(reportPath);
        var failed = false;
        foreach (var (key, label) in Gated)
        {
            if (!budgets.TryGetValue(key, out var limit))
                continue;
            if (!measured.TryGetValue(key, out var value))
            {
                Console.Error.WriteLine($"bench gate: {label} has a budget of {Ms(limit)} ms but the report has no number. Next: run dg-bench again.");
                failed = true;
            }
            else if (value > limit)
            {
                Console.Error.WriteLine($"bench gate: {label} {Ms(value)} ms is over the budget {Ms(limit)} ms. Next: fix the regression in the transport framing or raise the budget with a Budget-Increase line.");
                failed = true;
            }
            else
                Console.Out.WriteLine($"bench gate: {label} {Ms(value)} ms is within the budget {Ms(limit)} ms");
        }
        return failed ? 1 : 0;
    }

    private static string Ms(double value) => value.ToString("0.000", CultureInfo.InvariantCulture);

    private static Dictionary<string, double> ReadNumbers(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var numbers = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var property in document.RootElement.EnumerateObject())
            if (property.Value.ValueKind == JsonValueKind.Number)
                numbers[property.Name] = property.Value.GetDouble();
        return numbers;
    }
}

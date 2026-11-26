using System.Text.Json;

namespace Dg.Core.Plugins.Runtime;

public sealed record PluginApprovalRecord(
    string Name,
    string Kind,
    string Source,
    string PinKind,
    string PinValue,
    string TreeSha256,
    string? ApprovedSha256,
    string? Mac
)
{
    private const string RecordFile = "dg-plugin.json";

    public bool HasApproval =>
        ApprovedSha256 is not null && string.Equals(ApprovedSha256, TreeSha256, StringComparison.Ordinal);

    public static PluginApprovalRecord? Read(string folder)
    {
        var file = Path.Combine(folder, RecordFile);
        try
        {
            if (!File.Exists(file))
                return null;
            using var document = JsonDocument.Parse(File.ReadAllBytes(file));
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("pin", out var pin))
                return null;
            return Text(root, "name") is { } name
                && Text(root, "kind") is { } kind
                && Text(root, "source") is { } source
                && Text(pin, "kind") is { } pinKind
                && Text(pin, "value") is { } pinValue
                && Text(root, "treeSha256") is { } tree
                ? new PluginApprovalRecord(name, kind, source, pinKind, pinValue, tree, Text(root, "approvedSha256"), Text(root, "mac"))
                : null;
        }
        catch (Exception ex) when (ex is JsonException or IOException or InvalidOperationException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string? Text(JsonElement element, string key) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(key, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

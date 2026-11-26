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
    private static readonly string[] Keys = ["name", "kind", "source", "pin", "treeSha256", "approvedSha256"];
    private static readonly string[] SignedKeys = [.. Keys, "mac"];
    private static readonly string[] PinKeys = ["kind", "value"];

    public bool HasApproval =>
        ApprovedSha256 is not null && string.Equals(ApprovedSha256, TreeSha256, StringComparison.Ordinal);

    public string Pin => $"{PinKind}:{PinValue}";

    public string[] SignedFields() => [Name, Kind, Source, PinKind, PinValue, TreeSha256, ApprovedSha256 ?? ""];

    public static PluginApprovalRecord? Read(string folder)
    {
        var file = Path.Combine(folder, RecordFile);
        try
        {
            return File.Exists(file) ? Parse(File.ReadAllBytes(file)) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public static PluginApprovalRecord? Parse(ReadOnlySpan<byte> json)
    {
        try
        {
            using var document = JsonDocument.Parse(json.ToArray());
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !(HasExactly(root, Keys) || HasExactly(root, SignedKeys)))
                return null;
            var pin = root.GetProperty("pin");
            if (pin.ValueKind != JsonValueKind.Object || !HasExactly(pin, PinKeys))
                return null;
            return Text(root, "name") is { } name
                && Text(root, "kind") is { } kind
                && Text(root, "source") is { } source
                && Text(pin, "kind") is { } pinKind
                && Text(pin, "value") is { } pinValue
                && Text(root, "treeSha256") is { } tree
                && OptionalText(root, "approvedSha256", out var approved)
                && OptionalText(root, "mac", out var mac)
                && (mac is null || PluginApproval.TryDecode32(mac, out _))
                ? new PluginApprovalRecord(name, kind, source, pinKind, pinValue, tree, approved, mac)
                : null;
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    private static string? Text(JsonElement element, string key) =>
        element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool OptionalText(JsonElement element, string key, out string? text)
    {
        text = null;
        if (!element.TryGetProperty(key, out var value) || value.ValueKind == JsonValueKind.Null)
            return true;
        text = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return text is not null;
    }

    private static bool HasExactly(JsonElement element, string[] keys)
    {
        var count = 0;
        foreach (var property in element.EnumerateObject())
        {
            count++;
            if (Array.IndexOf(keys, property.Name) < 0)
                return false;
        }
        return count == keys.Length;
    }
}

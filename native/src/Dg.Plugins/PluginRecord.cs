using System.Text;
using System.Text.Json;
using Dg.Core.Plugins.Runtime;

namespace Dg.Plugins;

internal sealed record PluginRecord(
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
    private static readonly string[] Keys = ["name", "kind", "source", "pin", "treeSha256", "approvedSha256"];
    private static readonly string[] SignedKeys = [.. Keys, "mac"];

    public bool HasApproval =>
        ApprovedSha256 is not null && string.Equals(ApprovedSha256, TreeSha256, StringComparison.Ordinal);

    public string Pin => $"{PinKind}:{PinValue}";

    public static PluginRecord Parse(ReadOnlySpan<byte> json, string expectedName)
    {
        try
        {
            using var document = JsonDocument.Parse(json.ToArray());
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !(HasExactly(root, Keys) || HasExactly(root, SignedKeys)))
                throw new NotNativeException();
            var pin = root.GetProperty("pin");
            if (pin.ValueKind != JsonValueKind.Object || !HasExactly(pin, ["kind", "value"]))
                throw new NotNativeException();
            var approved = root.GetProperty("approvedSha256");
            var record = new PluginRecord(
                Text(root, "name"),
                Text(root, "kind"),
                Text(root, "source"),
                Text(pin, "kind"),
                Text(pin, "value"),
                Text(root, "treeSha256"),
                approved.ValueKind == JsonValueKind.Null ? null : Text(root, "approvedSha256"),
                ReadMac(root)
            );
            return string.Equals(record.Name, expectedName, StringComparison.Ordinal)
                ? record
                : throw new NotNativeException();
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            throw new NotNativeException(ex);
        }
    }

    public string ToJson()
    {
        var sink = new StringBuilder("{\n\t\"name\": ");
        JsonText.Quote(sink, Name);
        sink.Append(",\n\t\"kind\": ");
        JsonText.Quote(sink, Kind);
        sink.Append(",\n\t\"source\": ");
        JsonText.Quote(sink, Source);
        sink.Append(",\n\t\"pin\": {\n\t\t\"kind\": ");
        JsonText.Quote(sink, PinKind);
        sink.Append(",\n\t\t\"value\": ");
        JsonText.Quote(sink, PinValue);
        sink.Append("\n\t},\n\t\"treeSha256\": ");
        JsonText.Quote(sink, TreeSha256);
        sink.Append(",\n\t\"approvedSha256\": ");
        if (ApprovedSha256 is null)
            sink.Append("null");
        else
            JsonText.Quote(sink, ApprovedSha256);
        sink.Append(",\n\t\"mac\": ");
        if (Mac is null)
            sink.Append("null");
        else
            JsonText.Quote(sink, Mac);
        return sink.Append("\n}\n").ToString();
    }

    private static string? ReadMac(JsonElement root)
    {
        if (!root.TryGetProperty("mac", out var mac) || mac.ValueKind == JsonValueKind.Null)
            return null;
        var text = mac.ValueKind == JsonValueKind.String ? mac.GetString()! : throw new NotNativeException();
        return PluginApproval.TryDecode32(text, out _) ? text : throw new NotNativeException();
    }

    private static string Text(JsonElement element, string key)
    {
        var value = element.GetProperty(key);
        return value.ValueKind == JsonValueKind.String ? value.GetString()! : throw new NotNativeException();
    }

    private static bool HasExactly(JsonElement element, string[] keys)
    {
        var count = 0;
        foreach (var property in element.EnumerateObject())
        {
            count++;
            if (!keys.Contains(property.Name))
                return false;
        }
        return count == keys.Length;
    }
}

using System.Text;
using Dg.Core.Plugins.Runtime;

namespace Dg.Plugins;

internal static class PluginRecordFile
{
    public static PluginApprovalRecord Parse(ReadOnlySpan<byte> json, string expectedName) =>
        PluginApprovalRecord.Parse(json) is { } record && string.Equals(record.Name, expectedName, StringComparison.Ordinal)
            ? record
            : throw new NotNativeException();

    public static string ToJson(this PluginApprovalRecord record)
    {
        var sink = new StringBuilder("{\n\t\"name\": ");
        JsonText.Quote(sink, record.Name);
        sink.Append(",\n\t\"kind\": ");
        JsonText.Quote(sink, record.Kind);
        sink.Append(",\n\t\"source\": ");
        JsonText.Quote(sink, record.Source);
        sink.Append(",\n\t\"pin\": {\n\t\t\"kind\": ");
        JsonText.Quote(sink, record.PinKind);
        sink.Append(",\n\t\t\"value\": ");
        JsonText.Quote(sink, record.PinValue);
        sink.Append("\n\t},\n\t\"treeSha256\": ");
        JsonText.Quote(sink, record.TreeSha256);
        sink.Append(",\n\t\"approvedSha256\": ");
        if (record.ApprovedSha256 is null)
            sink.Append("null");
        else
            JsonText.Quote(sink, record.ApprovedSha256);
        sink.Append(",\n\t\"mac\": ");
        if (record.Mac is null)
            sink.Append("null");
        else
            JsonText.Quote(sink, record.Mac);
        return sink.Append("\n}\n").ToString();
    }
}

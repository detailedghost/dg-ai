using System.Security.Cryptography;
using System.Text;

namespace Dg.Core.Plugins.Runtime;

internal static class HmacFields
{
    private const int StackLimit = 512;

    public static void Append(IncrementalHash hash, string field, bool first = false)
    {
        if (!first)
            hash.AppendData([0]);
        var max = Encoding.UTF8.GetMaxByteCount(field.Length);
        Span<byte> buffer = max <= StackLimit ? stackalloc byte[max] : new byte[max];
        hash.AppendData(buffer[..Encoding.UTF8.GetBytes(field, buffer)]);
    }
}

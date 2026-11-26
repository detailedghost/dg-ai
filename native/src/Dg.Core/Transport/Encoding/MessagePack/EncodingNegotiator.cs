using Dg.Core.Plugins.Contract;

namespace Dg.Core.Transport.Codec;

public static class EncodingNegotiator
{
    public const string JsonName = "json";
    public const string MessagePackName = "msgpack";

    public static FrameEncoding Choose(IReadOnlyList<string> clientOffers, IReadOnlyList<string> pluginOffers)
    {
        ArgumentNullException.ThrowIfNull(clientOffers);
        ArgumentNullException.ThrowIfNull(pluginOffers);
        return Contains(clientOffers) && Contains(pluginOffers) ? FrameEncoding.MessagePack : FrameEncoding.Json;
    }

    public static string Name(FrameEncoding encoding) =>
        encoding switch
        {
            FrameEncoding.Json => JsonName,
            FrameEncoding.MessagePack => MessagePackName,
            _ => throw new ArgumentOutOfRangeException(nameof(encoding)),
        };

    private static bool Contains(IReadOnlyList<string> offers)
    {
        for (var i = 0; i < offers.Count; i++)
        {
            if (string.Equals(offers[i], MessagePackName, StringComparison.Ordinal))
                return true;
        }
        return false;
    }
}

namespace Dg.Core.Plugins.Contract;

public static class PluginProtocol
{
    public const int Version = 1;
    public const int HeaderBytes = 12;
    public const int MaxPayloadBytes = 1_048_576;
    public const int UdpMaxFrameBytes = 1_200;
}

namespace Dg.Core.Plugins.Contract;

public readonly record struct PluginResponse(FrameHeader Header, ReadOnlyMemory<byte> Payload);

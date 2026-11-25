using System.Buffers;
using Dg.Core.Plugins.Contract;

namespace Dg.Core.Transport.Framing;

public readonly record struct Frame(FrameHeader Header, ReadOnlySequence<byte> Payload);

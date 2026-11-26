namespace Dg.Core.Plugins.Contract;

[Flags]
public enum FrameFlags : ushort
{
    None = 0,
    Response = 0b001,
    Error = 0b010,
    Event = 0b100,
}

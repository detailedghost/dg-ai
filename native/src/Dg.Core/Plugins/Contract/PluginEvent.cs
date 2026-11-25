namespace Dg.Core.Plugins.Contract;

public readonly record struct PluginEvent(string Route, ReadOnlyMemory<byte> Body);

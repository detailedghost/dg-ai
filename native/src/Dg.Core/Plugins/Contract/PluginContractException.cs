namespace Dg.Core.Plugins.Contract;

public sealed class PluginContractException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

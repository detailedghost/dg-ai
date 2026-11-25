namespace Dg.Core.Abstractions;

public interface IPlugin
{
    string Name { get; }

    PluginKind Kind { get; }
}

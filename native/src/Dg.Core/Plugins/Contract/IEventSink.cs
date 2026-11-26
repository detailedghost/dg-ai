namespace Dg.Core.Plugins.Contract;

public interface IEventSink
{
    void Post(in PluginEvent ev);
}

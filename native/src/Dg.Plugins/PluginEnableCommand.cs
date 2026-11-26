using Dg.Core.Output;

namespace Dg.Plugins;

internal sealed class PluginEnableCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : APluginSwitchCommand(env, output, error, enable: true)
{
    public override string Name => "plugin enable";
}

using Dg.Core.Output;

namespace Dg.Plugins;

internal sealed class PluginDisableCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : APluginSwitchCommand(env, output, error, enable: false)
{
    public override string Name => "plugin disable";
}

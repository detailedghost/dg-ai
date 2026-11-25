using Dg.Core.Abstractions;
using Dg.Core.Output;

namespace Dg.Plugins;

internal static class PluginCommands
{
    public static ICommand[] Create(
        IReadOnlyDictionary<string, string?> env,
        OutputWriter output,
        OutputWriter error
    ) => [new PluginListCommand(env, output, error), new PluginVerifyCommand(env, output, error)];
}

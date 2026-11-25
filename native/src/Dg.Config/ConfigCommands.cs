using Dg.Core.Abstractions;
using Dg.Core.Output;

namespace Dg.Config;

internal static class ConfigCommands
{
    public static ICommand[] Create(
        IReadOnlyDictionary<string, string?> env,
        OutputWriter output,
        OutputWriter error
    ) =>
        [
            new ConfigGetCommand(env, output, error),
            new ConfigSetCommand(env, output, error),
            new ConfigListCommand(env, output, error),
            new ConfigDoctorCommand(env, output, error),
        ];
}

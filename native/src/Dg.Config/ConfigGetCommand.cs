using Dg.Core.Abstractions;
using Dg.Core.Config;
using Dg.Core.Output;

namespace Dg.Config;

public sealed class ConfigGetCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : AConfigCommand(env, output, error)
{
    public override string Name => "config get";

    protected override int Run(string[] args)
    {
        if (args.Length != 1 || HasOption(args))
            return ExitCodes.NotNative;
        var key = args[0];
        switch (ConfigKeys.Classify(key, out var known))
        {
            case KeyKind.Hook:
                return ExitCodes.NotNative;
            case KeyKind.Unknown:
                return Fail(
                    $"dg config: {key} is not a dg config key. Next: see docs/config.md for the keys, or run dg config edit."
                );
        }
        var location = Locate();
        if (!location.IsOk)
            return Fail(location.Error!);
        if (location.Value!.WaitsForMigration)
            return ExitCodes.NotNative;
        var toml = DgConfig.Load(location.Value.Seams);
        if (!toml.IsOk)
            return Fail(toml.Error!);
        if (ConfigRules.IsInvalid(key))
            return Fail($"dg config: {key} is not a valid key. Next: use dotted names such as install.cli_only.");
        Output.WriteLine(ConfigValues.Shown(DgSettings.Lookup(toml.Value!, key) ?? known.Fallback));
        return 0;
    }
}

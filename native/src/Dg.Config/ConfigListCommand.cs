using Dg.Core.Abstractions;
using Dg.Core.Config;
using Dg.Core.Output;

namespace Dg.Config;

public sealed class ConfigListCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : AConfigCommand(env, output, error)
{
    public override string Name => "config list";

    protected override int Run(string[] args)
    {
        if (args.Length != 0)
            return ExitCodes.NotNative;
        var location = Locate();
        if (!location.IsOk)
            return Fail(location.Error!);
        if (location.Value!.WaitsForMigration)
            return ExitCodes.NotNative;
        var result = DgConfig.Load(location.Value.Seams);
        if (!result.IsOk)
            return Fail(result.Error!);
        var toml = result.Value!;
        foreach (var key in ConfigKeys.DefaultKeys)
            Line(key, ConfigValues.Lookup(toml, key) ?? ConfigKeys.DefaultOf(key));
        if (toml.RefsDefaultRepo is { } repo)
            Line("refs.default_repo", repo);
        foreach (var (alias, target) in toml.RefsAliases)
            Line($"refs.aliases.{alias}", target);
        foreach (var (name, plugin) in toml.Plugins)
        {
            Line($"plugins.{name}.enabled", plugin.Enabled);
            if (plugin.Source is { } source)
                Line($"plugins.{name}.source", source);
        }
        return 0;
    }

    private void Line(string key, object? value) => Output.WriteLine($"{key} = {ConfigValues.Shown(value)}");
}

using Dg.Core.Abstractions;
using Dg.Core.Config;
using Dg.Core.Output;

namespace Dg.Config;

public sealed class ConfigDoctorCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : AConfigCommand(env, output, error)
{
    public override string Name => "config doctor";

    protected override int Run(string[] args)
    {
        if (args.Length != 0)
            return ExitCodes.NotNative;
        var location = Locate();
        if (!location.IsOk)
            return Fail(location.Error!);
        var file = location.Value!.File;
        if (!location.Value.Exists)
        {
            if (location.Value.HasLegacySources())
                return ExitCodes.NotNative;
            Output.WriteLine($"{file} does not exist; defaults apply");
            return 0;
        }
        var result = DgConfig.Parse(File.ReadAllText(file), file);
        if (!result.IsOk)
            return Fail(result.Error!);
        Output.WriteLine($"{file} is valid");
        return 0;
    }
}

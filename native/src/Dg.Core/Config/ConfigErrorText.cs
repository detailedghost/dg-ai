using Dg.Core.Errors;

namespace Dg.Core.Config;

public static class ConfigErrorText
{
    public static string Render(DgError error) =>
        error switch
        {
            { File.Length: > 0 } =>
                $"dg config: {error.File}:{error.Line ?? 1}: {error.Message} Next: {error.NextStep}",
            { NextStep.Length: > 0 } => $"dg config: {error.Message} Next: {error.NextStep}",
            _ => error.Message,
        };
}

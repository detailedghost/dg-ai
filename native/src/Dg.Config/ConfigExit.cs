namespace Dg.Config;

/// <summary>Exit codes a config command returns beyond the process range.</summary>
public static class ConfigExit
{
    /// <summary>The command could not run natively and wrote nothing. The composition root must hand the original argv to dg-core.</summary>
    public const int NotNative = -1;
}

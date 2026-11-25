namespace Dg.Plugins;

public static class PluginsExit
{
    /// <summary>The command did not run natively and changed nothing. The composition root must hand the original argv to dg-core.</summary>
    public const int NotNative = -1;
}

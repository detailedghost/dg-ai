namespace Dg.Plugins;

internal sealed class NotNativeException : Exception
{
    public NotNativeException() { }

    public NotNativeException(Exception inner)
        : base(null, inner) { }
}

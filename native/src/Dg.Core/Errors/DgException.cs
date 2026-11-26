namespace Dg.Core.Errors;

public sealed class DgException(DgError error) : Exception(error.Format())
{
    public DgError Error { get; } = error;
}

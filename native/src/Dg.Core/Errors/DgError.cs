namespace Dg.Core.Errors;

public sealed record DgError(string File, int? Line, string Key, string Message, string NextStep)
{
    public string Format() =>
        $"{File}{(Line is { } line ? $":{line}" : "")} {Key}: {Message}\nnext: {NextStep}";

    public DgException ToException() => new(this);
}

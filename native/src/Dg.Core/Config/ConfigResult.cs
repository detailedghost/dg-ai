using Dg.Core.Errors;

namespace Dg.Core.Config;

public readonly record struct ConfigResult<T>
{
    public T? Value { get; }
    public DgError? Error { get; }
    public bool IsOk => Error is null;

    private ConfigResult(T? value, DgError? error)
    {
        Value = value;
        Error = error;
    }

    public static ConfigResult<T> Ok(T value) => new(value, null);

    public static ConfigResult<T> Fail(DgError error) => new(default, error);

    public T GetOrThrow() => Error is { } error ? throw error.ToException() : Value!;
}

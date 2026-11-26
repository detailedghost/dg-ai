namespace Dg.Core.Abstractions;

public interface ICommand
{
    string Name { get; }

    ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct);
}

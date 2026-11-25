using System.Collections.Frozen;
using Dg.Core.Abstractions;

namespace Dg.Routing;

public sealed class Route
{
    public abstract record ATarget;

    public sealed record Native(ICommand Command, ReadOnlyMemory<string> Args) : ATarget;

    public sealed record Core(string[] Argv) : ATarget;

    private readonly record struct Entry(string[] Words, ICommand Command);

    private readonly FrozenDictionary<string, Entry[]> _natives;

    public Route(IEnumerable<ICommand> natives)
    {
        ArgumentNullException.ThrowIfNull(natives);
        var byFirst = new Dictionary<string, List<Entry>>(StringComparer.Ordinal);
        foreach (var command in natives)
        {
            var words = command.Name.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (words.Length == 0)
            {
                continue;
            }
            if (!byFirst.TryGetValue(words[0], out var list))
            {
                byFirst[words[0]] = list = [];
            }
            list.Add(new Entry(words, command));
        }
        _natives = byFirst.ToFrozenDictionary(
            static p => p.Key,
            static p => p.Value.OrderByDescending(static e => e.Words.Length).ToArray(),
            StringComparer.Ordinal
        );
    }

    public ATarget Resolve(ReadOnlySpan<string> argv)
    {
        if (argv.Length > 0 && _natives.TryGetValue(argv[0], out var entries))
        {
            foreach (var entry in entries)
            {
                if (StartsWith(argv, entry.Words))
                {
                    return new Native(entry.Command, argv[entry.Words.Length..].ToArray());
                }
            }
        }
        return new Core(argv.ToArray());
    }

    private static bool StartsWith(ReadOnlySpan<string> argv, string[] words)
    {
        if (argv.Length < words.Length)
        {
            return false;
        }
        for (var i = 0; i < words.Length; i++)
        {
            if (!string.Equals(argv[i], words[i], StringComparison.Ordinal))
            {
                return false;
            }
        }
        return true;
    }
}

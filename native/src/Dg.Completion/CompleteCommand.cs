using System.Text;
using Dg.Core.Abstractions;
using Dg.Core.Output;

namespace Dg.Completion;

public sealed class CompleteCommand : ICommand
{
    private const string ResourceName = "completion-tree.json";

    public string Name => "__complete";

    public ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct)
    {
        if (LoadTree() is not { } tree)
            return ValueTask.FromResult(ExitCodes.NotNative);

        var root = CompletionTree.Parse(tree);
        var lines = Completer.Complete(root, args.Span);
        if (lines.Count == 0)
        {
            return ValueTask.FromResult(0);
        }

        var text = new StringBuilder();
        foreach (var line in lines)
        {
            text.Append(line).Append('\n');
        }

        OutputWriter.Out.Write(text.ToString());
        OutputWriter.Out.Flush();
        return ValueTask.FromResult(0);
    }

    internal static byte[]? LoadTree()
    {
        using var embedded = typeof(CompleteCommand).Assembly.GetManifestResourceStream(ResourceName);
        if (embedded is null)
            return null;

        var bytes = new byte[embedded.Length];
        embedded.ReadExactly(bytes);
        return bytes;
    }
}

namespace Dg.Completion;

internal enum ValueKind
{
    None,
    Path,
    Any,
    Choices,
}

internal sealed record CompletionOption(
    string[] Flags,
    string? Description,
    ValueKind Kind,
    string[]? Choices,
    CompletionNode? Mode
);

internal sealed record CompletionNode(
    string Name,
    string? Description,
    CompletionNode[]? Commands,
    CompletionOption[]? Options,
    string[]? Values,
    bool Path
);

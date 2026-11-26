namespace Dg.Hooks.Shared;

internal readonly record struct CommandResult(int Status, string Stdout, string Stderr, bool Truncated = false);

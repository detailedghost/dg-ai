namespace Dg.Hooks.Engine;

internal static class ApplyPatch
{
    private const string ToolName = "apply_patch";
    private static readonly string[] FileHeaders =
        ["*** Add File: ", "*** Update File: ", "*** Delete File: "];
    private const string DeleteHeader = "*** Delete File: ";
    private const string MoveHeader = "*** Move to: ";

    public static HookEvent[] Expand(HookEvent ev)
    {
        if (ev.ToolName != ToolName)
            return [ev];
        if (ev.Command is not { } patch)
            return [];

        var cwd = ev.Cwd ?? Directory.GetCurrentDirectory();
        List<HookEvent> edits = [];
        string? path = null;
        List<string>? added = null;

        void Flush()
        {
            if (path is not null && added is not null)
                edits.Add(ToEdit(ev, cwd, path, string.Join('\n', added)));
        }

        foreach (var line in patch.Split('\n'))
        {
            if (HeaderPath(line) is { } header)
            {
                Flush();
                var isDelete = line.StartsWith(DeleteHeader, StringComparison.Ordinal);
                path = isDelete ? null : header;
                added = isDelete ? null : [];
            }
            else if (line.StartsWith(MoveHeader, StringComparison.Ordinal) && line.Length > MoveHeader.Length)
            {
                if (path is not null)
                    path = line[MoveHeader.Length..];
            }
            else if (line.StartsWith("***", StringComparison.Ordinal) || line.StartsWith("@@", StringComparison.Ordinal))
            {
                continue;
            }
            else if (added is not null && line.StartsWith('+'))
            {
                added.Add(line[1..]);
            }
        }
        Flush();
        return [.. edits];
    }

    private static string? HeaderPath(string line)
    {
        foreach (var header in FileHeaders)
        {
            if (line.StartsWith(header, StringComparison.Ordinal) && line.Length > header.Length)
                return line[header.Length..];
        }
        return null;
    }

    private static HookEvent ToEdit(HookEvent source, string cwd, string path, string added) =>
        new()
        {
            EventName = source.EventName,
            ToolName = "Edit",
            Cwd = source.Cwd,
            SessionId = source.SessionId,
            Source = source.Source,
            ResponseFilePath = source.ResponseFilePath,
            Args = source.Args,
            FilePath = Path.IsPathRooted(path) ? path : Path.GetFullPath(Path.Combine(cwd, path)),
            NewString = added,
        };
}

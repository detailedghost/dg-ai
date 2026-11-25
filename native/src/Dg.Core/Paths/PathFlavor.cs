using System.Text;

namespace Dg.Core.Paths;

public enum DgPlatform
{
    Linux,
    MacOs,
    Windows,
}

internal readonly record struct PathFlavor(bool Windows)
{
    public static PathFlavor For(DgPlatform platform) => new(platform == DgPlatform.Windows);

    public char Separator => Windows ? '\\' : '/';

    public bool IsAbsolute(string path) =>
        Windows
            ? path.Length > 0 && path[0] is '/' or '\\' || path.Length > 2 && path[1] == ':' && path[2] is '/' or '\\'
            : path.StartsWith('/');

    public string Join(params string[] parts) => Normalize(string.Join(Separator, parts));

    public string Resolve(string path, string cwd) => IsAbsolute(path) ? Normalize(path) : Join(cwd, path);

    public string Normalize(string path)
    {
        var text = Windows ? path.Replace('/', '\\') : path;
        var root = Root(text);
        List<string> kept = [];
        foreach (var part in text[root.Length..].Split(Separator))
        {
            if (part.Length == 0 || part == ".")
                continue;
            if (part == "..")
            {
                if (kept.Count > 0 && kept[^1] != "..")
                    kept.RemoveAt(kept.Count - 1);
                else if (root.Length == 0)
                    kept.Add(part);
                continue;
            }
            kept.Add(part);
        }
        var builder = new StringBuilder(root);
        builder.AppendJoin(Separator, kept);
        return builder.Length == 0 ? "." : builder.ToString();
    }

    private string Root(string text)
    {
        if (!Windows)
            return text.StartsWith('/') ? "/" : "";
        if (text.StartsWith(@"\\", StringComparison.Ordinal))
            return @"\\";
        if (text.Length > 1 && text[1] == ':')
            return text.Length > 2 && text[2] == '\\' ? text[..3] : text[..2];
        return text.StartsWith('\\') ? "\\" : "";
    }
}

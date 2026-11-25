using System.Buffers;

namespace Dg.Core.Paths;

public enum DgPlatform
{
    Linux,
    MacOs,
    Windows,
}

internal readonly record struct PathFlavor(bool Windows)
{
    private const int StackLimit = 512;

    public static PathFlavor For(DgPlatform platform) => new(platform == DgPlatform.Windows);

    public char Separator => Windows ? '\\' : '/';

    public bool IsAbsolute(string path) =>
        Windows
            ? path.Length > 0 && path[0] is '/' or '\\' || path.Length > 2 && path[1] == ':' && path[2] is '/' or '\\'
            : path.StartsWith('/');

    public string Join(params ReadOnlySpan<string> parts)
    {
        var length = Math.Max(parts.Length - 1, 0);
        foreach (var part in parts)
            length += part.Length;
        char[]? rented = null;
        Span<char> joined = length <= StackLimit ? stackalloc char[length] : rented = ArrayPool<char>.Shared.Rent(length);
        try
        {
            var at = 0;
            for (var i = 0; i < parts.Length; i++)
            {
                if (i > 0)
                    joined[at++] = Separator;
                parts[i].CopyTo(joined[at..]);
                at += parts[i].Length;
            }
            return Normalize(joined[..at]);
        }
        finally
        {
            if (rented is not null)
                ArrayPool<char>.Shared.Return(rented);
        }
    }

    public string Resolve(string path, string cwd) => IsAbsolute(path) ? Normalize(path) : Join(cwd, path);

    public string Normalize(ReadOnlySpan<char> path)
    {
        char[]? rented = null;
        Span<char> text = path.Length <= StackLimit ? stackalloc char[path.Length] : rented = ArrayPool<char>.Shared.Rent(path.Length);
        try
        {
            text = text[..path.Length];
            path.CopyTo(text);
            if (Windows)
                text.Replace('/', '\\');
            var rootLength = RootLength(text);
            var write = rootLength;
            var read = rootLength;
            while (read < text.Length)
            {
                var next = text[read..].IndexOf(Separator);
                var end = next < 0 ? text.Length : read + next;
                var segment = text[read..end];
                read = end + 1;
                if (segment.IsEmpty || segment is ".")
                    continue;
                if (segment is "..")
                {
                    var kept = text[rootLength..write];
                    var cut = kept.LastIndexOf(Separator);
                    if (!kept.IsEmpty && kept[(cut + 1)..] is not "..")
                        write = cut < 0 ? rootLength : rootLength + cut;
                    else if (rootLength == 0)
                        write = Append(text, write, rootLength, segment);
                    continue;
                }
                write = Append(text, write, rootLength, segment);
            }
            return write == 0 ? "." : new string(text[..write]);
        }
        finally
        {
            if (rented is not null)
                ArrayPool<char>.Shared.Return(rented);
        }
    }

    private int Append(Span<char> text, int write, int rootLength, ReadOnlySpan<char> segment)
    {
        if (write > rootLength)
            text[write++] = Separator;
        segment.CopyTo(text[write..]);
        return write + segment.Length;
    }

    private int RootLength(ReadOnlySpan<char> text)
    {
        if (!Windows)
            return !text.IsEmpty && text[0] == '/' ? 1 : 0;
        if (text.StartsWith(@"\\"))
            return 2;
        if (text.Length > 1 && text[1] == ':')
            return text.Length > 2 && text[2] == '\\' ? 3 : 2;
        return !text.IsEmpty && text[0] == '\\' ? 1 : 0;
    }
}

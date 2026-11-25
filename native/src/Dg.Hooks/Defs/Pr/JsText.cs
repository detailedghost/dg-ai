using System.Globalization;
using System.Text;

namespace Dg.Hooks.Defs.Pr;

internal static class JsText
{
    public static bool IsSpace(char c) =>
        c is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680'
            or (>= '\u2000' and <= '\u200a') or '\u2028' or '\u2029' or '\u202f' or '\u205f'
            or '\u3000' or '\uFEFF';

    public static ReadOnlySpan<char> Trim(ReadOnlySpan<char> text)
    {
        var start = 0;
        var end = text.Length;
        while (start < end && IsSpace(text[start]))
            start++;
        while (end > start && IsSpace(text[end - 1]))
            end--;
        return text[start..end];
    }

    public static string Trim(string text) => Trim(text.AsSpan()).ToString();

    public static bool IsBlank(string text) => Trim(text.AsSpan()).IsEmpty;

    public static string Slice(string text, int start, int end)
    {
        var from = Math.Min(Math.Max(start, 0), text.Length);
        var to = Math.Min(Math.Max(end, 0), text.Length);
        return to <= from ? "" : text.Substring(from, to - from);
    }

    public static string StripOneCarriageReturn(string line) =>
        line.Length > 0 && line[^1] == '\r' ? line[..^1] : line;

    public static double ToNumber(string text)
    {
        var trimmed = Trim(text.AsSpan());
        if (trimmed.IsEmpty)
            return 0;
        if (trimmed.Length > 2 && trimmed[0] == '0' && Radix(trimmed[1]) is var radix and > 0)
            return Integer(trimmed[2..], radix);
        if (trimmed is "Infinity" or "+Infinity")
            return double.PositiveInfinity;
        if (trimmed is "-Infinity")
            return double.NegativeInfinity;
        foreach (var c in trimmed)
            if (!(char.IsAsciiDigit(c) || c is '+' or '-' or '.' or 'e' or 'E'))
                return double.NaN;
        return double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? value
            : double.NaN;
    }

    public static double FiniteOr(string? raw, double fallback) =>
        !string.IsNullOrEmpty(raw) && ToNumber(raw) is var value && double.IsFinite(value) ? value : fallback;

    public static string Format(double value) =>
        double.IsNaN(value) ? "NaN"
        : double.IsInfinity(value) ? (value > 0 ? "Infinity" : "-Infinity")
        : value == Math.Floor(value) && Math.Abs(value) < 1e15 ? ((long)value).ToString(CultureInfo.InvariantCulture)
        : value.ToString("R", CultureInfo.InvariantCulture);

    public static int Words(ReadOnlySpan<char> text)
    {
        var trimmed = Trim(text);
        if (trimmed.IsEmpty)
            return 0;
        var count = 0;
        var inWord = false;
        foreach (var c in trimmed)
        {
            var separator = c is ' ' or '\t';
            if (!separator && !inWord)
                count++;
            inWord = !separator;
        }
        return count;
    }

    public static string ReadUtf8(string path) => Encoding.UTF8.GetString(File.ReadAllBytes(path));

    private static int Radix(char marker) =>
        marker switch
        {
            'x' or 'X' => 16,
            'o' or 'O' => 8,
            'b' or 'B' => 2,
            _ => 0,
        };

    private static double Integer(ReadOnlySpan<char> digits, int radix)
    {
        double value = 0;
        foreach (var c in digits)
        {
            var digit = char.IsAsciiDigit(c) ? c - '0'
                : char.IsAsciiLetter(c) ? char.ToLowerInvariant(c) - 'a' + 10
                : int.MaxValue;
            if (digit >= radix)
                return double.NaN;
            value = (value * radix) + digit;
        }
        return value;
    }
}

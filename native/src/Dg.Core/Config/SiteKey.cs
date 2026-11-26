using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace Dg.Core.Config;

internal static class SiteKey
{
    private const int MaxPort = 65535;

    public static bool IsValid(string value)
    {
        ReadOnlySpan<char> rest;
        string defaultPort;
        if (value.StartsWith("https://", StringComparison.Ordinal))
        {
            rest = value.AsSpan(8);
            defaultPort = "443";
        }
        else if (value.StartsWith("http://", StringComparison.Ordinal))
        {
            rest = value.AsSpan(7);
            defaultPort = "80";
        }
        else
            return false;
        if (rest.IsEmpty || !HasOnlyKeyCharacters(rest))
            return false;
        var hostEnd = HostEnd(rest);
        if (hostEnd <= 0)
            return false;
        var host = rest[..hostEnd];
        var tail = rest[hostEnd..];
        var hostOk = host[0] == '[' ? IsCanonicalIpv6(host[1..^1]) : IsDomainOrIpv4(host);
        return hostOk && (tail.IsEmpty || (tail[0] == ':' && IsPort(tail[1..], defaultPort)));
    }

    private static int HostEnd(ReadOnlySpan<char> rest)
    {
        if (rest[0] == '[')
            return rest.IndexOf(']') + 1;
        var colon = rest.IndexOf(':');
        return colon >= 0 ? colon : rest.Length;
    }

    private static bool HasOnlyKeyCharacters(ReadOnlySpan<char> text)
    {
        foreach (var c in text)
            if (c is not (>= 'a' and <= 'z') and not (>= '0' and <= '9') and not ('.' or ':' or '[' or ']' or '-'))
                return false;
        return true;
    }

    private static bool IsPort(ReadOnlySpan<char> text, string defaultPort) =>
        text.Length is >= 1 and <= 5
        && !text.ContainsAnyExceptInRange('0', '9')
        && text[0] != '0'
        && int.Parse(text, CultureInfo.InvariantCulture) <= MaxPort
        && !text.SequenceEqual(defaultPort);

    private static bool IsCanonicalIpv6(ReadOnlySpan<char> text) =>
        !text.ContainsAny('.', '%')
        && IPAddress.TryParse(text, out var address)
        && address.AddressFamily == AddressFamily.InterNetworkV6
        && text.SequenceEqual(address.ToString());

    private static bool IsDomainOrIpv4(ReadOnlySpan<char> host)
    {
        if (host.Contains(']') || host.Contains('[') || !AllLabelsValid(host))
            return false;
        var last = host[(host.LastIndexOf('.') + 1)..];
        return last.IsEmpty || !(IsNumber(last) || last.StartsWith("0x", StringComparison.Ordinal))
            || IsCanonicalIpv4(host);
    }

    private static bool AllLabelsValid(ReadOnlySpan<char> host)
    {
        foreach (var range in host.Split('.'))
        {
            var label = host[range];
            if (label.IsEmpty || label[0] == '-' || label[^1] == '-')
                return false;
        }
        return true;
    }

    private static bool IsNumber(ReadOnlySpan<char> text) => !text.ContainsAnyExceptInRange('0', '9');

    private static bool IsCanonicalIpv4(ReadOnlySpan<char> host)
    {
        var parts = 0;
        foreach (var range in host.Split('.'))
        {
            var part = host[range];
            if (++parts > 4 || !IsOctet(part))
                return false;
        }
        return parts == 4;
    }

    private static bool IsOctet(ReadOnlySpan<char> part) =>
        part.Length is >= 1 and <= 3
        && IsNumber(part)
        && (part.Length == 1 || part[0] != '0')
        && int.Parse(part, CultureInfo.InvariantCulture) <= 255;
}

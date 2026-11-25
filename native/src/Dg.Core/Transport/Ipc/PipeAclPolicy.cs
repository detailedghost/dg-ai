namespace Dg.Core.Transport.Ipc;

internal static class PipeAclPolicy
{
    private const string LocalSystem = "S-1-5-18";
    private const string Administrators = "S-1-5-32-544";

    public static bool IsUserOnly(string userSid, string? ownerSid, IEnumerable<(string Sid, bool Allow)> rules)
    {
        if (ownerSid is not null && !IsTrusted(userSid, ownerSid))
            return false;
        foreach (var (sid, allow) in rules)
        {
            if (allow && !IsTrusted(userSid, sid))
                return false;
        }
        return true;
    }

    private static bool IsTrusted(string userSid, string sid) =>
        sid.Equals(userSid, StringComparison.OrdinalIgnoreCase) || sid is LocalSystem or Administrators;
}

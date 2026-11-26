namespace Dg.Hooks.Defs.Repo;

internal static class PruneLock
{
    private const double StaleMs = 10 * 60_000;

    public static string? Take(string lockPath, TimeProvider time)
    {
        var token = $"{Environment.ProcessId}-{Guid.NewGuid()}";
        if (TryCreate(lockPath, token))
            return token;
        try
        {
            if (!IsStale(lockPath, time))
                return null;
            var aside = $"{lockPath}.{token}";
            File.Move(lockPath, aside);
            if (!IsStale(aside, time))
            {
                try
                {
                    File.Move(aside, lockPath);
                }
                catch (IOException) { }
                File.Delete(aside);
                return null;
            }
            File.Delete(aside);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        return TryCreate(lockPath, token) ? token : null;
    }

    public static void Release(string lockPath, string token)
    {
        try
        {
            if (File.ReadAllText(lockPath) == token)
                File.Delete(lockPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    private static bool TryCreate(string lockPath, string token)
    {
        try
        {
            using var stream = new FileStream(lockPath, FileMode.CreateNew, FileAccess.Write);
            stream.Write(System.Text.Encoding.UTF8.GetBytes(token));
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsStale(string file, TimeProvider time)
    {
        var info = new FileInfo(file);
        if (!info.Exists)
            throw new FileNotFoundException(file);
        return (time.GetUtcNow() - info.LastWriteTimeUtc).TotalMilliseconds >= StaleMs;
    }
}

using System.Runtime.InteropServices;

namespace Dg.Parity.Tests.Harness;

internal sealed class FrontDoorHost
{
    private const string CoreScript = """
        #!/bin/sh
        if [ -n "$DG_PARITY_LOG" ]; then echo core >> "$DG_PARITY_LOG"; fi
        if [ "$DG_PARITY_CORE" = "bun" ]; then
          exec "$DG_PARITY_BUN" "$DG_PARITY_ENTRY" "$@"
        fi
        printf 'core argv:'
        for arg in "$@"; do printf ' [%s]' "$arg"; done
        printf '\n'
        printf 'core stdin:'
        cat
        printf '\n'
        exit "${DG_PARITY_EXIT:-0}"
        """;

    private static readonly string[] Runtime = ["dg", "dg.dll", "dg.deps.json", "dg.runtimeconfig.json"];

    public static FrontDoorHost Shared { get; } = new();

    public string RepoRoot { get; } = FindRepoRoot();

    public string Bun { get; } = FindBun();

    public string BunEntry => Path.Combine(RepoRoot, "pkg", "launcher", "src", "dg.ts");

    public string DotnetRoot { get; } = FindDotnetRoot();

    public string WithCore { get; }

    public string WithoutCore { get; }

    private FrontDoorHost()
    {
        var root = Directory.CreateTempSubdirectory("dg-parity-install-").FullName;
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Directory.Delete(root, recursive: true);
        WithCore = Install(Path.Combine(root, "with-core"), withCore: true);
        WithoutCore = Install(Path.Combine(root, "without-core"), withCore: false);
    }

    public static bool IsPublishedBinary => Environment.GetEnvironmentVariable("DG_PARITY_FRONT") is { Length: > 0 };

    private static string Install(string directory, bool withCore)
    {
        Directory.CreateDirectory(directory);
        var front = Path.Combine(directory, "dg");
        if (Environment.GetEnvironmentVariable("DG_PARITY_FRONT") is { Length: > 0 } published)
        {
            File.Copy(published, front);
        }
        else
        {
            foreach (var file in Directory.GetFiles(AppContext.BaseDirectory, "*.dll"))
                File.Copy(file, Path.Combine(directory, Path.GetFileName(file)), overwrite: true);
            foreach (var name in Runtime)
                File.Copy(Path.Combine(AppContext.BaseDirectory, name), Path.Combine(directory, name), overwrite: true);
        }
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(front, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        if (withCore && !OperatingSystem.IsWindows())
        {
            var core = Path.Combine(directory, "dg-core");
            File.WriteAllText(core, CoreScript.ReplaceLineEndings("\n") + "\n");
            File.SetUnixFileMode(core, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        return front;
    }

    private static string FindRepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "pkg", "launcher", "src", "dg.ts")))
                return dir.FullName;
        throw new InvalidOperationException("pkg/launcher/src/dg.ts not found above the test output");
    }

    private static string FindBun()
    {
        var name = OperatingSystem.IsWindows() ? "bun.exe" : "bun";
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir, name);
            if (File.Exists(candidate))
                return candidate;
        }
        var home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".bun", "bin", name);
        return File.Exists(home) ? home : throw new InvalidOperationException("bun is not on PATH");
    }

    private static string FindDotnetRoot() =>
        Environment.GetEnvironmentVariable("DOTNET_ROOT") is { Length: > 0 } configured
            ? configured
            : Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", ".."));
}

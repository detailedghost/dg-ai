using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Dg.Hooks.Engine;

namespace Dg.Hooks.Defs.Pr;

internal sealed class PrProseHook(PrHookHost host) : IHook
{
    private const PrAction Actions = PrAction.Create | PrAction.Edit | PrAction.Update;

    private const string ValeHint =
        "pr-prose: Vale is not installed, so style checks are off. Install it from https://vale.sh to add them. The built-in checks still ran.\n";
    private const string ValeUnconfigured =
        "pr-prose: Vale is installed but HOOK_PR_PROSE_VALE_CONFIG is not set, so style checks are off. The built-in checks still ran.\n";
    private const string ValeFailed =
        "pr-prose: the Vale run failed, so style checks were skipped. The built-in checks still ran.\n";

    private readonly record struct Outcome(int Exit, string Stderr, string? Context);

    public string Id => "pr-prose";

    public async ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
    {
        var commands = PrCommandParser.Invocations(ev.Command ?? "", Actions, ev.Cwd);
        if (commands.Count == 0 || Bypassed(ev))
            return 0;
        var cwd = ev.Cwd ?? Directory.GetCurrentDirectory();
        var outcome = new Outcome(0, "", null);
        foreach (var call in commands)
        {
            var body = PrBodyExtractor.Extract(call.Source, call.Cwd ?? cwd).TrimEnd('\n');
            if (JsText.IsBlank(body))
                continue;
            outcome = await CheckBodyAsync(body, ev, ct);
            if (outcome.Exit != 0)
                break;
        }
        if (outcome.Context is { } context)
            host.Output.Write(AdditionalContext(context));
        if (outcome.Stderr != "")
            host.Error.Write(outcome.Stderr);
        return outcome.Exit;
    }

    private bool Bypassed(HookEvent ev)
    {
        var scratch = ScratchDirectory.Hooks(host.Env);
        foreach (var session in (string[])[host.SessionOf(ev.SessionId), host.MarkerSession()])
        {
            var marker = Path.Combine(scratch, $"pr-prose-disabled.{session}");
            if (Path.Exists(marker))
                return true;
        }
        return false;
    }

    private async ValueTask<Outcome> CheckBodyAsync(string body, HookEvent ev, CancellationToken ct)
    {
        var findings = PrBodyScanner.Scan(body, JsText.FiniteOr(host.Value("HOOK_PR_PROSE_MAX_SENTENCE"), 40));
        var hint = "";
        if (PrProcess.Which(host.Env, "vale") is null)
        {
            hint = ValeHint;
        }
        else if (host.Value("HOOK_PR_PROSE_VALE_CONFIG") is not { Length: > 0 } config)
        {
            hint = ValeUnconfigured;
        }
        else
        {
            var configPath = PrCommandParser.ResolvePath(ev.Cwd ?? Directory.GetCurrentDirectory(), config);
            var (valeFindings, notice) = await ValeFindingsAsync(body, configPath, ct);
            findings.InsertRange(0, valeFindings);
            hint = notice;
        }

        if (findings.Count == 0)
            return hint != "" && FirstHint(host.SessionOf(ev.SessionId))
                ? new Outcome(0, "", JsText.Trim(hint))
                : new Outcome(0, "", null);

        var max = JsText.FiniteOr(host.Value("HOOK_PR_PROSE_MAX_FINDINGS"), 12);
        PrBodyScanner.SortByLine(findings);
        var shown = ShownCount(max, findings.Count);
        StringBuilder text = new(hint);
        text.Append($"PR body does not read as plain English ({findings.Count} issue(s)):\n");
        for (var i = 0; i < shown; i++)
            text.Append($"  body line {JsText.Format(findings[i].Line)}: {findings[i].Message}\n");
        if (findings.Count > max)
            text.Append(
                $"  ... ({JsText.Format(findings.Count - max)} more, raise HOOK_PR_PROSE_MAX_FINDINGS to see all)\n"
            );
        text.Append(
            "fix: rewrite the body as plain English - short active sentences that say what changed and why - then retry.\n"
        );
        return new Outcome(2, text.ToString(), null);
    }

    private static int ShownCount(double max, int total)
    {
        var whole = Math.Truncate(max);
        return (int)(whole < 0 ? Math.Max(total + whole, 0) : Math.Min(whole, total));
    }

    private async ValueTask<(List<Finding> Findings, string Notice)> ValeFindingsAsync(
        string body,
        string config,
        CancellationToken ct
    )
    {
        var scratch = ScratchDirectory.Hooks(host.Env);
        var dir = MakeTempDirectory(scratch, "pr-prose.");
        try
        {
            await File.WriteAllBytesAsync(Path.Combine(dir, "body.md"), Encoding.UTF8.GetBytes($"{body}\n"), ct);
            var level = host.Value("HOOK_PR_PROSE_LEVEL") ?? "warning";
            var result = await PrProcess.RunAsync(
                host.Env,
                "vale",
                [
                    $"--config={config}",
                    $"--minAlertLevel={level}",
                    "--filter=.Name != \"Vale.Spelling\"",
                    "--output=line",
                    "body.md",
                ],
                dir
            );
            List<Finding> findings = [];
            foreach (var row in result.Stdout.Split('\n'))
            {
                var parts = row.Split(':');
                if (parts.Length < 5 || parts[1] == "" || parts[3] == "")
                    continue;
                var message = JsText.Trim(string.Join(':', parts[4..]));
                findings.Add(new Finding(JsText.ToNumber(parts[1]), $"{message} ({parts[3]})"));
            }
            var failed = result.Status == 127 || (result.Status != 0 && findings.Count == 0);
            return (findings, failed ? ValeFailed : "");
        }
        finally
        {
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException) { }
        }
    }

    private bool FirstHint(string session)
    {
        var scratch = ScratchDirectory.Hooks(host.Env);
        var marker = Path.Combine(scratch, $"pr-prose-hint.{session}");
        if (Path.Exists(marker))
            return false;
        File.WriteAllBytes(marker, []);
        return true;
    }

    private static string MakeTempDirectory(string parent, string prefix)
    {
        while (true)
        {
            var path = Path.Combine(parent, prefix + Path.GetRandomFileName().Replace(".", "", StringComparison.Ordinal)[..6]);
            if (Path.Exists(path))
                continue;
            if (OperatingSystem.IsWindows())
                Directory.CreateDirectory(path);
            else
                Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            return path;
        }
    }

    private static string AdditionalContext(string text) =>
        $$$"""{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"{{{JsonEncodedText.Encode(text, JavaScriptEncoder.UnsafeRelaxedJsonEscaping)}}}"}}""";
}

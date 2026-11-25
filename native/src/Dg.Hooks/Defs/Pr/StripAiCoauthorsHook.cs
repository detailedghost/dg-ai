using System.Text;
using System.Text.RegularExpressions;
using Dg.Core.Config;
using Dg.Hooks.Engine;
using Dg.Hooks.Shared;

namespace Dg.Hooks.Defs.Pr;

internal sealed partial class StripAiCoauthorsHook(PrHookHost host) : IHook
{
    private const string HookId = "strip-ai-coauthors";
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    [GeneratedRegex(@"\A(?:utf-?8)?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Utf8Name();

    public string Id => HookId;

    public bool UsesStdin(string[] args) => false;

    public async ValueTask<int> RunAsync(HookEvent ev, CancellationToken ct)
    {
        if (ev.Args.Length == 0 || ev.Args[0] == "")
        {
            host.Error.Write($"hooks run {HookId}: needs the commit message file\n");
            return 2;
        }
        if (!IsEnabled())
            return 0;
        var file = ev.Args[0];
        var bytes = await File.ReadAllBytesAsync(file, ct);
        string message;
        try
        {
            message = StrictUtf8.GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return 0;
        }
        var encoding = await HookProcess.RunAsync(host.Env, ["git", "config", "--get", "i18n.commitEncoding"], host.Cwd, ct);
        if (encoding.Status == 0 && !Utf8Name().IsMatch(JsText.Trim(encoding.Stdout)))
            return 0;
        var config = await HookProcess.RunAsync(host.Env, ["git", "config", "--get", "core.commentChar"], host.Cwd, ct);
        var configured = config.Status == 0 ? JsText.Trim(config.Stdout) : "";
        var stripped = AiCoauthors.Strip(message, CommentCharOf(configured, message));
        if (stripped != message)
            await File.WriteAllBytesAsync(file, StrictUtf8.GetBytes(stripped), ct);
        return 0;
    }

    private bool IsEnabled() =>
        host.Value("DG_STRIP_AI_COAUTHORS") switch
        {
            "1" => true,
            "0" => false,
            _ => SavedEnabled(),
        };

    private bool SavedEnabled()
    {
        var loaded = DgConfig.Load(host.Env);
        return loaded.IsOk
            && loaded.Value!.Hooks.TryGetValue(HookId, out var settings)
            && settings.TryGetValue("enabled", out var value)
            && value.Equals("on", StringComparison.OrdinalIgnoreCase);
    }

    private static string CommentCharOf(string configured, string message) =>
        configured == "" ? "#"
        : configured != "auto" ? configured[..1]
        : AiCoauthors.AutoCommentChar(message);
}

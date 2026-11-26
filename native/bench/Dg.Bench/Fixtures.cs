using System.Text.Json;
using Dg.Core.Abstractions;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Manifest;

namespace Dg.Bench;

internal static class Fixtures
{
    public const string PluginName = "bench";
    public const string Token = "bench-token";

    public static readonly byte[] AllowBody = "{\"decision\":\"allow\"}"u8.ToArray();

    public static HookDecideRequest HookRequest { get; } =
        new(
            "PreToolUse",
            "Bash",
            JsonDocument.Parse("""{"command":"git status --short","cwd":"/home/user/code/project"}""").RootElement.Clone()
        );

    public static byte[] EnvelopePayload { get; } =
        JsonSerializer.SerializeToUtf8Bytes(
            new PluginEnvelope(
                PluginRoutes.HookDecide,
                JsonSerializer.SerializeToElement(HookRequest, PluginJsonContext.Default.HookDecideRequest)
            ),
            PluginJsonContext.Default.PluginEnvelope
        );

    public static PluginManifest HttpManifest(int port) =>
        new(
            PluginName,
            "1.0.0",
            PluginKind.Hook,
            PluginTransportKind.Http,
            $"http://127.0.0.1:{port}",
            false,
            null,
            null,
            new PluginEntry(null, "bench", []),
            new PluginCapabilities(false, [], [], []),
            new PluginPermissions([], [])
        );
}

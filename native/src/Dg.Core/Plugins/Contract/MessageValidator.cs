using System.Text.Json;

namespace Dg.Core.Plugins.Contract;

public enum MessageDirection
{
    Request,
    Response,
}

public static class MessageValidator
{
    private static readonly string[] Encodings = ["json", "msgpack"];
    private static readonly string[] Decisions = ["allow", "deny", "ask"];
    private static readonly string[] JobStates = ["queued", "running", "succeeded", "failed"];
    private static readonly string[] HealthStates = ["ok", "degraded"];

    public static void Validate(string route, MessageDirection direction, JsonElement body)
    {
        if (!PluginRoutes.IsKnown(route))
            throw UnknownRoute(route);
        if (body.ValueKind != JsonValueKind.Object)
            throw Bad("body", "body must be an object");
        switch (route, direction)
        {
            case (PluginRoutes.Hello, MessageDirection.Request):
                ProtocolOne(body);
                if (!StringList(body, "encodings", "json"))
                    throw Bad("body.encodings", "encodings must include json, every plugin reads json");
                StringList(body, "capabilities");
                OptionalString(body, "token");
                break;
            case (PluginRoutes.Hello, MessageDirection.Response):
                ProtocolOne(body);
                OneOf(body, "encoding", Encodings);
                StringList(body, "capabilities");
                break;
            case (PluginRoutes.HookDecide, MessageDirection.Request):
                RequireString(body, "event");
                OptionalString(body, "tool");
                if (body.TryGetProperty("input", out var input) && input.ValueKind != JsonValueKind.Object)
                    throw Bad("body.input", "input must be an object");
                break;
            case (PluginRoutes.HookDecide, MessageDirection.Response):
                OneOf(body, "decision", Decisions);
                OptionalString(body, "reason");
                break;
            case (PluginRoutes.JobRun, MessageDirection.Request):
                RequireString(body, "job");
                if (body.TryGetProperty("args", out _))
                    StringList(body, "args");
                break;
            case (PluginRoutes.JobRun, MessageDirection.Response):
                RequireString(body, "runId");
                break;
            case (PluginRoutes.JobStatus, MessageDirection.Request):
                RequireString(body, "runId");
                break;
            case (PluginRoutes.JobStatus, MessageDirection.Response):
                OneOf(body, "state", JobStates);
                if (body.TryGetProperty("exitCode", out var exit) && !IsInteger(exit))
                    throw Bad("body.exitCode", "exitCode must be an integer");
                break;
            case (PluginRoutes.SkillDescribe, MessageDirection.Response):
                RequireString(body, "name");
                RequireString(body, "description");
                StringList(body, "files");
                break;
            case (PluginRoutes.Health, MessageDirection.Response):
                OneOf(body, "status", HealthStates);
                RequireString(body, "version");
                break;
        }
    }

    internal static PluginContractException UnknownRoute(string route) =>
        Bad("route", $"{route} is not a v1 route; the routes are {string.Join(", ", PluginRoutes.All)}");

    private static PluginContractException Bad(string key, string message) =>
        new("message", $"dg plugin: {key}: {message}. Next: fix the message, see docs/plugin-protocol.md.");

    private static bool IsInteger(JsonElement value) =>
        value.ValueKind == JsonValueKind.Number
        && value.TryGetDouble(out var number)
        && double.IsFinite(number)
        && number == Math.Truncate(number);

    private static string Shown(JsonElement body, string name) =>
        body.TryGetProperty(name, out var value) ? JsonSerializer.Serialize(value, PluginJsonContext.Default.JsonElement) : "undefined";

    private static void ProtocolOne(JsonElement body)
    {
        if (!(body.TryGetProperty("protocol", out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && number == PluginProtocol.Version))
            throw Bad(
                "body.protocol",
                $"protocol must be protocol {PluginProtocol.Version}, got {Shown(body, "protocol")}"
            );
    }

    private static void RequireString(JsonElement body, string name)
    {
        if (!(body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !value.ValueEquals(""u8)))
            throw Bad($"body.{name}", $"{name} is required and must be a non-empty string");
    }

    private static void OptionalString(JsonElement body, string name)
    {
        if (body.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.String)
            throw Bad($"body.{name}", $"{name} must be a string");
    }

    private static bool StringList(JsonElement body, string name, string? wanted = null)
    {
        if (!body.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
            throw Bad($"body.{name}", $"{name} must be a list of strings");
        var found = false;
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
                throw Bad($"body.{name}", $"{name} must be a list of strings");
            found |= wanted is not null && item.ValueEquals(wanted);
        }
        return found;
    }

    private static void OneOf(JsonElement body, string name, string[] allowed)
    {
        if (body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
            foreach (var option in allowed)
                if (value.ValueEquals(option))
                    return;
        throw Bad($"body.{name}", $"{name} must be one of {string.Join(", ", allowed)}");
    }
}

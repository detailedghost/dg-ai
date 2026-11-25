using System.Text.Json;
using System.Text.Json.Serialization;

namespace Dg.Core.Plugins.Contract;

public sealed record PluginEnvelope(string Route, JsonElement Body);

public sealed record PluginErrorBody(string Code, string Message);

public sealed record HelloRequest(
    int Protocol,
    IReadOnlyList<string> Encodings,
    IReadOnlyList<string> Capabilities,
    string? Token = null
);

public sealed record HelloResponse(int Protocol, string Encoding, IReadOnlyList<string> Capabilities);

public sealed record HookDecideRequest(string Event, string? Tool = null, JsonElement? Input = null);

public sealed record HookDecideResponse(string Decision, string? Reason = null);

public sealed record JobRunRequest(string Job, IReadOnlyList<string>? Args = null);

public sealed record JobRunResponse(string RunId);

public sealed record JobStatusRequest(string RunId);

public sealed record JobStatusResponse(string State, int? ExitCode = null);

public sealed record SkillDescribeResponse(string Name, string Description, IReadOnlyList<string> Files);

public sealed record HealthResponse(string Status, string Version);

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
)]
[JsonSerializable(typeof(JsonElement))]
[JsonSerializable(typeof(PluginEnvelope))]
[JsonSerializable(typeof(PluginErrorBody))]
[JsonSerializable(typeof(HelloRequest))]
[JsonSerializable(typeof(HelloResponse))]
[JsonSerializable(typeof(HookDecideRequest))]
[JsonSerializable(typeof(HookDecideResponse))]
[JsonSerializable(typeof(JobRunRequest))]
[JsonSerializable(typeof(JobRunResponse))]
[JsonSerializable(typeof(JobStatusRequest))]
[JsonSerializable(typeof(JobStatusResponse))]
[JsonSerializable(typeof(SkillDescribeResponse))]
[JsonSerializable(typeof(HealthResponse))]
public sealed partial class PluginJsonContext : JsonSerializerContext;

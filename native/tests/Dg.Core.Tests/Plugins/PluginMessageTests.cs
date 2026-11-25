using System.Text.Json;
using Dg.Core.Plugins.Contract;

namespace Dg.Core.Tests.Plugins;

public sealed class PluginMessageTests
{
    public static TheoryData<string> ValidFiles() => Files("messages/valid");

    public static TheoryData<string> InvalidFiles() => Files("messages/invalid");

    private static TheoryData<string> Files(string folder)
    {
        var data = new TheoryData<string>();
        foreach (var file in PluginFixtures.Files(folder, "*.json"))
            data.Add(file);
        return data;
    }

    private static string Compact(JsonElement element) => JsonSerializer.Serialize(element);

    private static MessageDirection DirectionOf(JsonElement root) =>
        root.GetProperty("direction").GetString() == "request" ? MessageDirection.Request : MessageDirection.Response;

    private static string RoundTrip(string route, MessageDirection direction, JsonElement body) =>
        (route, direction) switch
        {
            ("/v1/hello", MessageDirection.Request) => Serialize(body.Deserialize(PluginJsonContext.Default.HelloRequest)!),
            ("/v1/hello", MessageDirection.Response) => Serialize(body.Deserialize(PluginJsonContext.Default.HelloResponse)!),
            ("/v1/hook/decide", MessageDirection.Request) => Serialize(body.Deserialize(PluginJsonContext.Default.HookDecideRequest)!),
            ("/v1/hook/decide", MessageDirection.Response) => Serialize(body.Deserialize(PluginJsonContext.Default.HookDecideResponse)!),
            ("/v1/job/run", MessageDirection.Request) => Serialize(body.Deserialize(PluginJsonContext.Default.JobRunRequest)!),
            ("/v1/job/run", MessageDirection.Response) => Serialize(body.Deserialize(PluginJsonContext.Default.JobRunResponse)!),
            ("/v1/job/status", MessageDirection.Request) => Serialize(body.Deserialize(PluginJsonContext.Default.JobStatusRequest)!),
            ("/v1/job/status", MessageDirection.Response) => Serialize(body.Deserialize(PluginJsonContext.Default.JobStatusResponse)!),
            ("/v1/skill/describe", MessageDirection.Response) => Serialize(body.Deserialize(PluginJsonContext.Default.SkillDescribeResponse)!),
            ("/v1/health", MessageDirection.Response) => Serialize(body.Deserialize(PluginJsonContext.Default.HealthResponse)!),
            _ => Compact(body),
        };

    private static string Serialize(HelloRequest value) => JsonSerializer.Serialize(value, PluginJsonContext.Default.HelloRequest);

    private static string Serialize(HelloResponse value) => JsonSerializer.Serialize(value, PluginJsonContext.Default.HelloResponse);

    private static string Serialize(HookDecideRequest value) =>
        JsonSerializer.Serialize(value, PluginJsonContext.Default.HookDecideRequest);

    private static string Serialize(HookDecideResponse value) =>
        JsonSerializer.Serialize(value, PluginJsonContext.Default.HookDecideResponse);

    private static string Serialize(JobRunRequest value) => JsonSerializer.Serialize(value, PluginJsonContext.Default.JobRunRequest);

    private static string Serialize(JobRunResponse value) => JsonSerializer.Serialize(value, PluginJsonContext.Default.JobRunResponse);

    private static string Serialize(JobStatusRequest value) =>
        JsonSerializer.Serialize(value, PluginJsonContext.Default.JobStatusRequest);

    private static string Serialize(JobStatusResponse value) =>
        JsonSerializer.Serialize(value, PluginJsonContext.Default.JobStatusResponse);

    private static string Serialize(SkillDescribeResponse value) =>
        JsonSerializer.Serialize(value, PluginJsonContext.Default.SkillDescribeResponse);

    private static string Serialize(HealthResponse value) => JsonSerializer.Serialize(value, PluginJsonContext.Default.HealthResponse);

    [Theory]
    [MemberData(nameof(ValidFiles))]
    public void Validate_ValidFixture_Accepts(string file)
    {
        using var doc = PluginFixtures.ReadJson("messages", "valid", file);
        var root = doc.RootElement;

        MessageValidator.Validate(root.GetProperty("route").GetString()!, DirectionOf(root), root.GetProperty("body"));
    }

    [Theory]
    [MemberData(nameof(ValidFiles))]
    public void Serialize_ValidFixture_ProducesCompactFixtureBody(string file)
    {
        using var doc = PluginFixtures.ReadJson("messages", "valid", file);
        var root = doc.RootElement;
        var route = root.GetProperty("route").GetString()!;
        var body = root.GetProperty("body");

        Assert.Equal(Compact(body), RoundTrip(route, DirectionOf(root), body));
    }

    [Theory]
    [MemberData(nameof(InvalidFiles))]
    public void Validate_InvalidFixture_ThrowsKeyAndText(string file)
    {
        using var doc = PluginFixtures.ReadJson("messages", "invalid", file);
        var root = doc.RootElement;
        var expect = root.GetProperty("expect");
        var key = expect.GetProperty("key").GetString()!;

        var error = Assert.Throws<PluginContractException>(() =>
            MessageValidator.Validate(root.GetProperty("route").GetString()!, DirectionOf(root), root.GetProperty("body"))
        );

        Assert.StartsWith($"dg plugin: {key}: ", error.Message);
        Assert.Contains(expect.GetProperty("includes").GetString()!, error.Message);
        Assert.EndsWith(". Next: fix the message, see docs/plugin-protocol.md.", error.Message);
    }

    [Fact]
    public void Validate_HelloWrongProtocol_UsesExactText()
    {
        using var doc = JsonDocument.Parse("""{"protocol":2,"encodings":["json"],"capabilities":[]}""");

        var error = Assert.Throws<PluginContractException>(() =>
            MessageValidator.Validate("/v1/hello", MessageDirection.Request, doc.RootElement)
        );

        Assert.Equal(
            "dg plugin: body.protocol: protocol must be protocol 1, got 2. Next: fix the message, see docs/plugin-protocol.md.",
            error.Message
        );
    }

    [Fact]
    public void Envelope_HelloRequest_SerializesToFrameFixturePayload()
    {
        using var frames = PluginFixtures.ReadJson("frames", "frames.json");
        var expected = frames
            .RootElement.GetProperty("valid")
            .EnumerateArray()
            .Single(entry => entry.GetProperty("name").GetString() == "hello-request")
            .GetProperty("payloadText")
            .GetString();
        var hello = new HelloRequest(1, ["json", "msgpack"], ["hook"]);
        var envelope = new PluginEnvelope(
            "/v1/hello",
            JsonSerializer.SerializeToElement(hello, PluginJsonContext.Default.HelloRequest)
        );

        Assert.Equal(expected, JsonSerializer.Serialize(envelope, PluginJsonContext.Default.PluginEnvelope));
    }

    [Fact]
    public void ErrorBody_CodeAndMessage_SerializesToFrameFixturePayload()
    {
        var json = JsonSerializer.Serialize(
            new PluginErrorBody("bad-request", "body is not an object"),
            PluginJsonContext.Default.PluginErrorBody
        );

        Assert.Equal("""{"code":"bad-request","message":"body is not an object"}""", json);
    }
}

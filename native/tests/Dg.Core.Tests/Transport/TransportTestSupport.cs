using System.Text;
using Dg.Core.Plugins.Contract;
using Dg.Core.Transport.Framing;
using Dg.Core.Transport.Pool;

namespace Dg.Core.Tests.Transport;

internal static class TransportTestSupport
{
    public static readonly byte[] HookMessage = Encoding.UTF8.GetBytes(
        """{"route":"/v1/hook/decide","body":{"event":"pre-tool-use","tool":"Bash","command":"git status"}}"""
    );

    public static async Task Call(PluginConnection connection)
    {
        using var frame = FrameWriter.Encode(FrameEncoding.Json, FrameFlags.None, connection.NextRequestId(), HookMessage);
        var response = await connection.SendAsync(frame.Memory, CancellationToken.None);
        Assert.Equal(HookMessage.Length, response.Payload.Length);
    }
}

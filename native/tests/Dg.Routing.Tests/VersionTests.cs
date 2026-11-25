using System.Text;
using Dg.Core.Output;

namespace Dg.Routing.Tests;

public sealed class VersionTests
{
    [Theory]
    [InlineData("7.1.0", "9.9.9+abc", "7.1.0")]
    [InlineData(null, "7.1.0+abc123", "7.1.0")]
    [InlineData(null, "7.1.0", "7.1.0")]
    [InlineData(null, "1.0.0", "dev")]
    [InlineData(null, null, "dev")]
    [InlineData("", "", "dev")]
    public void Resolve_EnvAndAssemblyVersion_PicksBunEquivalentString(string? env, string? assembly, string expected)
    {
        Assert.Equal(expected, VersionCommand.Resolve(env, assembly));
    }

    [Fact]
    public async Task RunAsync_WritesVersionAndNewlineOnly()
    {
        using var stream = new MemoryStream();
        var command = new VersionCommand("7.1.0", new OutputWriter(stream));

        var code = await command.RunAsync(ReadOnlyMemory<string>.Empty, CancellationToken.None);

        Assert.Equal(0, code);
        Assert.Equal("7.1.0\n", Encoding.UTF8.GetString(stream.ToArray()));
        Assert.Equal("--version", command.Name);
    }
}

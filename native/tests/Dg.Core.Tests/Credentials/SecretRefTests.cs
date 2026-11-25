using Dg.Core.Credentials;
using Tomlyn.Model;

namespace Dg.Core.Tests.Credentials;

public sealed class SecretRefTests
{
    private sealed class FakeStore(Dictionary<string, string> values) : ICredentialStore
    {
        public ValueTask<string?> GetAsync(string name, CancellationToken cancellationToken) =>
            ValueTask.FromResult(values.GetValueOrDefault(name));
    }

    [Fact]
    public void TryRead_SingleCredentialKey_ReturnsReference()
    {
        var table = new TomlTable { ["credential"] = "acme/api-key" };

        Assert.True(SecretRef.TryRead(table, out var reference));
        Assert.Equal("acme/api-key", reference.Credential);
    }

    [Theory]
    [InlineData("Bad Name")]
    [InlineData("")]
    [InlineData("-lead")]
    public void TryRead_InvalidName_Refuses(string name)
    {
        Assert.False(SecretRef.TryRead(new TomlTable { ["credential"] = name }, out _));
    }

    [Fact]
    public void TryRead_ExtraKeyOrPlainString_Refuses()
    {
        var table = new TomlTable { ["credential"] = "a/b", ["value"] = "x" };

        Assert.False(SecretRef.TryRead(table, out _));
        Assert.False(SecretRef.TryRead("a/b", out _));
        Assert.False(SecretRef.TryRead(null, out _));
    }

    [Fact]
    public async Task ResolveAsync_KnownName_ReturnsStoredValue()
    {
        var store = new FakeStore(new() { ["acme/api-key"] = "fake-value" });

        var result = await SecretRefResolver.ResolveAsync(new SecretRef("acme/api-key"), store, TestContext.Current.CancellationToken);

        Assert.Equal("fake-value", result.Value);
    }

    [Fact]
    public async Task ResolveAsync_UnknownName_ReturnsErrorWithoutValue()
    {
        var result = await SecretRefResolver.ResolveAsync(new SecretRef("acme/none"), new FakeStore([]), TestContext.Current.CancellationToken);

        Assert.False(result.IsOk);
        Assert.Equal("acme/none", result.Error!.Key);
        Assert.Contains("dg credentials set acme/none", result.Error.NextStep);
    }
}

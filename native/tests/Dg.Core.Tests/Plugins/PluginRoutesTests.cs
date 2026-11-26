using Dg.Core.Plugins.Contract;

namespace Dg.Core.Tests.Plugins;

public sealed class PluginRoutesTests
{
    [Theory]
    [InlineData("/v1/hello", 1_000)]
    [InlineData("/v1/health", 1_000)]
    [InlineData("/v1/hook/decide", 2_000)]
    [InlineData("/v1/job/status", 2_000)]
    [InlineData("/v1/skill/describe", 2_000)]
    [InlineData("/v1/job/run", 10_000)]
    public void TimeoutFor_KnownRoute_ReturnsDocumentedTimeout(string route, int milliseconds)
    {
        Assert.Equal(TimeSpan.FromMilliseconds(milliseconds), PluginRoutes.TimeoutFor(route));
    }

    [Fact]
    public void TimeoutFor_UnknownRoute_Throws()
    {
        var error = Assert.Throws<PluginContractException>(() => PluginRoutes.TimeoutFor("/v2/hello"));

        Assert.StartsWith("dg plugin: route: /v2/hello is not a v1 route", error.Message);
    }

    [Fact]
    public void All_ListsSixRoutesInDocumentOrder()
    {
        Assert.Equal(
            ["/v1/hello", "/v1/hook/decide", "/v1/job/run", "/v1/job/status", "/v1/skill/describe", "/v1/health"],
            PluginRoutes.All
        );
    }

    [Fact]
    public void TokenCredential_PluginName_UsesDocumentedName()
    {
        Assert.Equal("plugin-secret-scan-token", PluginRoutes.TokenCredential("secret-scan"));
    }

    [Fact]
    public void HookLatencyBudget_MatchesDocument()
    {
        Assert.Equal(1, PluginRoutes.HookLatencyBudgetP99Ms.Ipc);
        Assert.Equal(2, PluginRoutes.HookLatencyBudgetP99Ms.Tcp);
        Assert.Equal(5, PluginRoutes.HookLatencyBudgetP99Ms.Http);
    }
}

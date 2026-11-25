using Dg.Core.Abstractions;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Plugins.Tests;

public sealed class PluginCommandTests
{
    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;

    [Fact]
    public void AddPlugins_Registers_OnlyListAndVerify()
    {
        var services = new FakeServices();

        services.AddPlugins();

        var names = services
            .Where(static d => d.ServiceType == typeof(ICommand))
            .Select(static d => ((ICommand)d.ImplementationFactory!(null!)).Name)
            .Order()
            .ToArray();
        Assert.Equal(["plugin list", "plugin verify"], names);
    }
}

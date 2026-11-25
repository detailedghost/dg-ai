using System.Reflection;
using Dg.Core.Abstractions;

namespace Dg.Core.Tests;

public sealed class CommandContractTests
{
    [Fact]
    public void RunAsync_Signature_MatchesContract()
    {
        var method = typeof(ICommand).GetMethod(nameof(ICommand.RunAsync));

        Assert.NotNull(method);
        Assert.Equal(typeof(ValueTask<int>), method.ReturnType);
        Assert.Equal(
            [typeof(ReadOnlyMemory<string>), typeof(CancellationToken)],
            method.GetParameters().Select(static p => p.ParameterType).ToArray()
        );
    }

    [Fact]
    public void Name_IsReadOnlyString()
    {
        var property = typeof(ICommand).GetProperty(nameof(ICommand.Name));

        Assert.NotNull(property);
        Assert.Equal(typeof(string), property.PropertyType);
        Assert.False(property.CanWrite);
    }

    [Fact]
    public void PluginKind_DefinesHookJobSkill()
    {
        Assert.Equal(["Hook", "Job", "Skill"], Enum.GetNames<PluginKind>());
    }

    [Fact]
    public void IPlugin_ExposesKindAndName()
    {
        Assert.Equal(typeof(PluginKind), typeof(IPlugin).GetProperty(nameof(IPlugin.Kind))?.PropertyType);
        Assert.Equal(typeof(string), typeof(IPlugin).GetProperty(nameof(IPlugin.Name))?.PropertyType);
    }
}

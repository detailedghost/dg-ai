using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Tests.Plugins.Runtime;

internal sealed class FactoryProvider(IEnumerable<ServiceDescriptor> descriptors) : IKeyedServiceProvider, IAsyncDisposable
{
    private readonly List<ServiceDescriptor> _descriptors = [.. descriptors];
    private readonly Dictionary<ServiceDescriptor, object> _built = [];

    public object? GetService(Type serviceType) => GetKeyedService(serviceType, null);

    public object GetRequiredKeyedService(Type serviceType, object? serviceKey) =>
        GetKeyedService(serviceType, serviceKey) ?? throw new InvalidOperationException($"no {serviceType.Name} for {serviceKey}");

    public object? GetKeyedService(Type serviceType, object? serviceKey)
    {
        if (serviceType == typeof(IServiceProvider))
            return this;
        if (serviceType == typeof(IEnumerable<Dg.Core.Plugins.Runtime.IBuiltinPlugin>))
            return _descriptors
                .Where(d => d.ServiceType == typeof(Dg.Core.Plugins.Runtime.IBuiltinPlugin))
                .Select(d => (Dg.Core.Plugins.Runtime.IBuiltinPlugin)Build(d))
                .ToArray();
        var match = _descriptors.LastOrDefault(d => d.ServiceType == serviceType && Equals(d.ServiceKey, serviceKey));
        return match is null ? null : Build(match);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var instance in _built.Values)
            if (instance is IAsyncDisposable disposable && !ReferenceEquals(instance, this))
                await disposable.DisposeAsync();
    }

    private object Build(ServiceDescriptor descriptor)
    {
        if (_built.TryGetValue(descriptor, out var existing))
            return existing;
        var made = descriptor.IsKeyedService
            ? descriptor.KeyedImplementationInstance
                ?? descriptor.KeyedImplementationFactory!(this, descriptor.ServiceKey)
            : descriptor.ImplementationInstance ?? descriptor.ImplementationFactory!(this);
        _built[descriptor] = made;
        return made;
    }
}

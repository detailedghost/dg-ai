namespace Dg.Core.Tests.Leaks;

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class LeakCollection
{
    public const string Name = "leaks";
}

namespace Dg.Completion.Tests;

public sealed class AllocationTests
{
    [Fact]
    public void LoadTree_EmbeddedResource_CopiesTheResourceOnce()
    {
        var tree = CompleteCommand.LoadTree();
        Assert.NotNull(tree);

        var bytes = AllocationProbe.BytesPerOp(() => CompleteCommand.LoadTree(), 100);

        Assert.True(bytes <= tree.Length + 1024, $"LoadTree allocated {bytes} B/op for {tree.Length} B of JSON");
    }

    [Fact]
    public void Parse_EmbeddedTree_DoesNotMaterializePropertyNames()
    {
        var tree = CompleteCommand.LoadTree()!;

        var bytes = AllocationProbe.BytesPerOp(() => CompletionTree.Parse(tree), 100);

        Assert.True(bytes <= tree.Length * 3.2, $"Parse allocated {bytes} B/op for {tree.Length} B of JSON");
    }
}

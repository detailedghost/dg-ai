namespace Dg.Completion.Tests;

public sealed class AllocationTests
{
    private const int LoadTreeSlackBytes = 1024;
    private const double ParseBytesPerJsonByte = 3.2;

    [Fact]
    public void LoadTree_EmbeddedResource_CopiesTheResourceOnce()
    {
        var tree = CompleteCommand.LoadTree();
        Assert.NotNull(tree);

        var bytes = AllocationProbe.BytesPerOp(() => CompleteCommand.LoadTree(), 100);

        Assert.True(bytes <= tree.Length + LoadTreeSlackBytes, $"LoadTree allocated {bytes} B/op for {tree.Length} B of JSON");
    }

    [Fact]
    public void Parse_EmbeddedTree_DoesNotMaterializePropertyNames()
    {
        var tree = CompleteCommand.LoadTree()!;

        var bytes = AllocationProbe.BytesPerOp(() => CompletionTree.Parse(tree), 100);

        Assert.True(bytes <= tree.Length * ParseBytesPerJsonByte, $"Parse allocated {bytes} B/op for {tree.Length} B of JSON");
    }
}

using Dg.Hooks.Engine;

namespace Dg.Hooks.Tests.Engine;

public sealed class ApplyPatchTests
{
    private static HookEvent Patch(string patch, string? cwd = "/work") =>
        new()
        {
            ToolName = "apply_patch",
            Command = patch,
            Cwd = cwd,
        };

    [Fact]
    public void Expand_NotApplyPatch_ReturnsEventUnchanged()
    {
        var ev = new HookEvent { ToolName = "Edit", FilePath = "a.md" };

        Assert.Equal([ev], ApplyPatch.Expand(ev));
    }

    [Fact]
    public void Expand_NoCommand_ReturnsNothing()
    {
        var ev = new HookEvent { ToolName = "apply_patch" };

        Assert.Empty(ApplyPatch.Expand(ev));
    }

    [Fact]
    public void Expand_AddAndUpdate_ReturnsOneEditPerFileWithAddedLines()
    {
        const string patch = """
            *** Begin Patch
            *** Add File: docs/new.md
            +first
            +second
            *** Update File: /abs/old.md
            @@
             context
            -removed
            +added
            *** End Patch
            """;

        var edits = ApplyPatch.Expand(Patch(patch));

        Assert.Collection(
            edits,
            first =>
            {
                Assert.Equal("Edit", first.ToolName);
                Assert.Equal("/work/docs/new.md", first.FilePath);
                Assert.Equal("first\nsecond", first.NewString);
                Assert.Null(first.Command);
            },
            second =>
            {
                Assert.Equal("/abs/old.md", second.FilePath);
                Assert.Equal("added", second.NewString);
            }
        );
    }

    [Fact]
    public void Expand_DeleteFile_IsDropped()
    {
        const string patch = "*** Delete File: gone.md\n+ignored\n*** Add File: kept.md\n+x";

        var edits = ApplyPatch.Expand(Patch(patch));

        Assert.Equal(["/work/kept.md"], edits.Select(e => e.FilePath));
    }

    [Fact]
    public void Expand_MoveTo_ReplacesPath()
    {
        const string patch = "*** Update File: a.md\n*** Move to: b/c.md\n+x";

        var edits = ApplyPatch.Expand(Patch(patch));

        Assert.Equal("/work/b/c.md", Assert.Single(edits).FilePath);
    }

    [Fact]
    public void Expand_PreservesSessionAndEventFields()
    {
        var ev = Patch("*** Add File: a.md\n+x") with { SessionId = "s1", EventName = "PostToolUse" };

        var edit = Assert.Single(ApplyPatch.Expand(ev));

        Assert.Equal("s1", edit.SessionId);
        Assert.Equal("PostToolUse", edit.EventName);
        Assert.Equal("/work", edit.Cwd);
    }
}

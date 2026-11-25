using System.Text;
using Dg.Hooks.Engine;

namespace Dg.Hooks.Tests.Engine;

public sealed class HookEventTests
{
    public static TheoryData<string, string, string?, string?> RamBudgetFixtures =>
        new()
        {
            {
                """{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"notes.md","old_string":"a","new_string":"the color of the center"},"tool_response":{"success":true},"cwd":"."}""",
                "PostToolUse",
                "Edit",
                "notes.md"
            },
            {
                """{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"},"cwd":"."}""",
                "PreToolUse",
                "Bash",
                null
            },
            {
                """{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"gh pr create --title \"fix(x): y\" --body \"This change fixes the bug. It adds a test.\""},"cwd":"."}""",
                "PreToolUse",
                "Bash",
                null
            },
            {
                """{"hook_event_name":"SessionStart","source":"startup","cwd":"."}""",
                "SessionStart",
                null,
                null
            },
        };

    [Theory]
    [MemberData(nameof(RamBudgetFixtures))]
    public void Parse_RamBudgetFixture_ReadsEventToolAndFile(
        string json,
        string eventName,
        string? toolName,
        string? filePath
    )
    {
        var ev = HookEvent.Parse(Encoding.UTF8.GetBytes(json));

        Assert.Equal(eventName, ev.EventName);
        Assert.Equal(toolName, ev.ToolName);
        Assert.Equal(filePath, ev.FilePath);
        Assert.Equal(".", ev.Cwd);
    }

    [Fact]
    public void Parse_EditFixture_ReadsStrings()
    {
        var ev = HookEvent.Parse(
            """{"tool_name":"Edit","tool_input":{"file_path":"notes.md","old_string":"a","new_string":"b"}}"""u8
        );

        Assert.Equal("a", ev.OldString);
        Assert.Equal("b", ev.NewString);
    }

    [Fact]
    public void Parse_PrFixture_ReadsCommandWithEscapedQuotes()
    {
        var ev = HookEvent.Parse(
            """{"tool_name":"Bash","tool_input":{"command":"gh pr create --title \"x\""}}"""u8
        );

        Assert.Equal("gh pr create --title \"x\"", ev.Command);
    }

    [Fact]
    public void Parse_CmdKeyOnly_FallsBackToCommand()
    {
        var ev = HookEvent.Parse("""{"tool_name":"Bash","tool_input":{"cmd":"ls"}}"""u8);

        Assert.Equal("ls", ev.Command);
    }

    [Fact]
    public void Parse_SessionStartFixture_ReadsSource()
    {
        var ev = HookEvent.Parse("""{"hook_event_name":"SessionStart","source":"startup"}"""u8);

        Assert.Equal("startup", ev.Source);
    }

    [Fact]
    public void Parse_SessionId_IsRead()
    {
        var ev = HookEvent.Parse("""{"session_id":"abc-1"}"""u8);

        Assert.Equal("abc-1", ev.SessionId);
    }

    [Fact]
    public void Parse_WriteContent_IsRead()
    {
        var ev = HookEvent.Parse(
            """{"tool_name":"Write","tool_input":{"file_path":"a.md","content":"hello"}}"""u8
        );

        Assert.Equal("hello", ev.Content);
    }

    [Fact]
    public void Parse_MultiEdit_CollectsNewStringsInOrder()
    {
        var ev = HookEvent.Parse(
            """{"tool_name":"MultiEdit","tool_input":{"file_path":"a.md","edits":[{"old_string":"x","new_string":"one"},{"old_string":"y","new_string":"two"},{"old_string":"z"}]}}"""u8
        );

        Assert.Equal(["one", "two", ""], ev.Edits);
    }

    [Fact]
    public void Parse_MultiEdit_NullOrNonObjectEdits_ContributeEmptyStrings()
    {
        var ev = HookEvent.Parse(
            """{"tool_name":"MultiEdit","tool_input":{"edits":[null,7,{"new_string":null},{"new_string":4}]}}"""u8
        );

        Assert.Equal(["", "", "", "4"], ev.Edits);
    }

    [Theory]
    [InlineData("12", "12")]
    [InlineData("1.5", "1.5")]
    [InlineData("true", "true")]
    [InlineData("false", "false")]
    [InlineData("{\"a\":1}", "[object Object]")]
    [InlineData("[1,\"a\",null,[2,3]]", "1,a,,2,3")]
    [InlineData("[]", "")]
    public void Parse_NonStringContentAndFilePath_BecomeJsString(string json, string expected)
    {
        var ev = HookEvent.Parse(
            Encoding.UTF8.GetBytes($$"""{"tool_name":"Write","tool_input":{"file_path":{{json}},"content":{{json}},"new_string":{{json}}}}""")
        );

        Assert.Equal(expected, ev.FilePath);
        Assert.Equal(expected, ev.Content);
        Assert.Equal(expected, ev.NewString);
    }

    [Fact]
    public void Parse_NullContentAndFilePath_StayNull()
    {
        var ev = HookEvent.Parse("""{"tool_input":{"file_path":null,"content":null}}"""u8);

        Assert.Null(ev.FilePath);
        Assert.Null(ev.Content);
    }

    [Fact]
    public void Parse_ToolResponseFilePath_IsRead()
    {
        var ev = HookEvent.Parse(
            """{"tool_name":"Write","tool_input":{"file_path":"in.md"},"tool_response":{"filePath":"out.md"}}"""u8
        );

        Assert.Equal("out.md", ev.ResponseFilePath);
        Assert.Equal("in.md", ev.FilePath);
    }

    [Fact]
    public void Parse_UnknownAndNestedProperties_AreSkipped()
    {
        var ev = HookEvent.Parse(
            """{"extra":{"deep":[1,{"a":"b"}]},"tool_name":"Edit","other":null,"cwd":"/w"}"""u8
        );

        Assert.Equal("Edit", ev.ToolName);
        Assert.Equal("/w", ev.Cwd);
    }

    [Fact]
    public void Parse_NonStringValues_AreIgnored()
    {
        var ev = HookEvent.Parse(
            """{"tool_name":7,"tool_input":{"file_path":null,"command":{"a":1}},"cwd":"/w"}"""u8
        );

        Assert.Null(ev.ToolName);
        Assert.Null(ev.FilePath);
        Assert.Null(ev.Command);
        Assert.Equal("/w", ev.Cwd);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[1,2]")]
    [InlineData("\"text\"")]
    [InlineData("""{"tool_name":"Edit""")]
    public void Parse_EmptyOrInvalidOrNonObject_ReturnsEmptyEvent(string json)
    {
        var ev = HookEvent.Parse(Encoding.UTF8.GetBytes(json));

        Assert.Equal(default, ev);
    }

    [Fact]
    public void Parse_Utf8WithBom_Parses()
    {
        var bytes = new byte[] { 0xEF, 0xBB, 0xBF }.Concat("""{"tool_name":"Edit"}"""u8.ToArray()).ToArray();

        Assert.Equal("Edit", HookEvent.Parse(bytes).ToolName);
    }
}

using System.Text.Json;

namespace Dg.Completion.Tests;

public sealed class ParityTests
{
    private static readonly Lazy<string> Out = new(FindOutDir);

    private static string OutDir => Out.Value;

    public static TheoryData<int> CaseIndexes()
    {
        var data = new TheoryData<int>();
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(OutDir, "parity.json")));
        for (var i = 0; i < document.RootElement.GetArrayLength(); i++)
        {
            data.Add(i);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(CaseIndexes))]
    public void Complete_BunFixture_ReturnsSameCandidates(int index)
    {
        using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(OutDir, "parity.json")));
        var fixture = document.RootElement[index];
        var words = fixture.GetProperty("words").EnumerateArray().Select(w => w.GetString()!).ToArray();
        var expected = fixture.GetProperty("candidates").EnumerateArray().Select(c => c.GetString()!).ToArray();
        var root = CompletionTree.Parse(File.ReadAllBytes(Path.Combine(OutDir, "tree.json")));

        var actual = Completer.Complete(root, words);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void Complete_UnknownCommand_ReturnsNothing()
    {
        var root = CompletionTree.Parse(File.ReadAllBytes(Path.Combine(OutDir, "tree.json")));

        Assert.Empty(Completer.Complete(root, ["no-such-command", ""]));
    }

    private static string FindOutDir()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "src", "Dg.Completion", "bin", "completion");
            if (File.Exists(Path.Combine(candidate, "parity.json")))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException("Run `bun scripts/native-completion.ts` first.");
    }
}

using System.Runtime.CompilerServices;
using Dg.Hooks.Defs.Text;

namespace Dg.Hooks.Tests.Text;

public sealed class SpellingPairsTests
{
    [Fact]
    public void Text_MatchesBunWordList()
    {
        var source = Path.GetFullPath(Path.Combine(Folder(), "../../../../pkg/skills-cli/src/hooks/data/spelling-pairs.txt"));

        Assert.Equal(
            SpellingPairs.Text.ReplaceLineEndings("\n"),
            File.ReadAllText(source).ReplaceLineEndings("\n").TrimEnd('\n')
        );
    }

    private static string Folder([CallerFilePath] string path = "") => Path.GetDirectoryName(path)!;
}

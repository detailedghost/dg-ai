using System.Text.RegularExpressions;

namespace Dg.Plugins;

internal readonly record struct SkillDir(string Name, string Prefix);

internal static partial class SkillLayout
{
    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]*\z")]
    private static partial Regex SkillName();

    public static List<SkillDir> Find(List<string> files, string pluginName)
    {
        if (files.Contains("SKILL.md"))
            return [new(pluginName, "")];
        var found = new Dictionary<string, SkillDir>(StringComparer.Ordinal);
        foreach (var file in files)
        {
            SkillDir? skill = file.Split('/') switch
            {
                ["skills", "SKILL.md"] => null,
                ["skills", var name, "SKILL.md"] => new(name, $"skills/{name}/"),
                [var name, "SKILL.md"] => new(name, $"{name}/"),
                _ => null,
            };
            if (skill is not { } hit)
                continue;
            if (!SkillName().IsMatch(hit.Name))
                throw new NotNativeException();
            found[hit.Name] = hit;
        }
        return [.. found.Values];
    }
}

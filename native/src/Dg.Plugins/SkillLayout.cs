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
            var parts = file.Split('/');
            if (parts[^1] != "SKILL.md")
                continue;
            var skills = parts[0] == "skills";
            var dir =
                skills && parts.Length == 3 ? parts[1]
                : parts.Length == 2 ? parts[0]
                : null;
            if (dir is null || (skills && parts.Length < 3))
                continue;
            if (!SkillName().IsMatch(dir))
                throw new NotNativeException();
            found[dir] = new(dir, skills ? $"skills/{dir}/" : $"{dir}/");
        }
        return [.. found.Values];
    }
}

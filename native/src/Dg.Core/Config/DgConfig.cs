using System.Text.RegularExpressions;
using Dg.Core.Errors;
using Dg.Core.Paths;
using Tomlyn;
using Tomlyn.Model;

namespace Dg.Core.Config;

public static partial class DgConfig
{
    private const string SyntaxNext = "run dg config edit, or dg config set <key> <value>.";

    [GeneratedRegex(@"\((\d+),\d+\) : error : (.+)\z")]
    private static partial Regex Reason();

    public static ConfigResult<DgToml> Parse(string text, string file)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(file);
        TomlTable root;
        try
        {
            root = TomlSerializer.Deserialize(text, DgTomlContext.Default.TomlTable) ?? new TomlTable();
        }
        catch (TomlException exception)
        {
            return ConfigResult<DgToml>.Fail(Syntax(exception, file));
        }
        try
        {
            return ConfigResult<DgToml>.Ok(DgTomlValidator.Validate(root, file, text));
        }
        catch (DgException exception)
        {
            return ConfigResult<DgToml>.Fail(exception.Error);
        }
    }

    public static ConfigResult<DgToml> Load(IReadOnlyDictionary<string, string?> env) =>
        Load(DgPathSeams.Current(env));

    public static ConfigResult<DgToml> Load(DgPathSeams seams)
    {
        var paths = DgPaths.Resolve(seams);
        if (!paths.IsOk)
            return ConfigResult<DgToml>.Fail(paths.Error!);
        var file = paths.Value!.ConfigTomlPath;
        return Parse(File.Exists(file) ? File.ReadAllText(file) : "", file);
    }

    private static DgError Syntax(TomlException exception, string file)
    {
        var reason = Reason().Match(exception.Message);
        var line = reason.Success ? int.Parse(reason.Groups[1].Value) : Math.Max(exception.Line ?? 1, 1);
        var message = reason.Success ? reason.Groups[2].Value.TrimEnd('.') : exception.Message;
        return new DgError(file, line, "", $"{message}.", SyntaxNext);
    }
}

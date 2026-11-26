using Dg.Core.Abstractions;
using Dg.Core.Config;
using Dg.Core.Errors;
using Dg.Core.Output;
using Tomlyn.Model;

namespace Dg.Config;

public sealed class ConfigSetCommand(
    IReadOnlyDictionary<string, string?> env,
    OutputWriter output,
    OutputWriter error
) : AConfigCommand(env, output, error)
{
    private const int Tries = 3;

    public override string Name => "config set";

    protected override int Run(string[] args)
    {
        if (args.Length is 0 or > 2 || HasOption(args))
            return ExitCodes.NotNative;
        var key = args[0];
        switch (ConfigKeys.Classify(key, out var known))
        {
            case KeyKind.Hook:
                return ExitCodes.NotNative;
            case KeyKind.Unknown:
                return Fail(
                    $"dg config: {key} is not a dg config key. Next: see docs/config.md for the keys, or run dg config edit."
                );
        }
        if (ConfigKeys.TurnsSendingOn(key))
            return Fail($"dg config: {key} turns sending on, so dg config set does not change it. Next: run dg config edit.");
        if (args.Length == 1)
            return Fail($"dg config: set needs a value. Next: run dg config set {key} <value>.");
        var value = known.Text ? args[1] : RawToml.ParseValue(args[1]);
        var location = Locate();
        if (!location.IsOk)
            return Fail(location.Error!);
        var file = location.Value!.File;
        if (ConfigRules.IsSecretKey(key) && value is string)
            return Fail(PlainSecret(file, 1, key));
        if (location.Value.WaitsForMigration)
            return ExitCodes.NotNative;
        return Update(file, key, value);
    }

    private int Update(string file, string key, object value)
    {
        for (var attempt = 1; ; attempt++)
        {
            var text = File.Exists(file) ? File.ReadAllText(file) : "";
            var current = DgConfig.Parse(text, file);
            if (!current.IsOk)
                return Fail(current.Error!);
            var raw = RawToml.Parse(text);
            if (ConfigRules.IsInvalid(key))
                return Fail($"dg config: {key} is not a valid key. Next: use dotted names such as install.cli_only.");
            if (Place(raw, key, value) is { } problem)
                return Fail(problem);
            var next = TomlWriter.Stringify(raw);
            var checkedText = DgConfig.Parse(next, file);
            if (!checkedText.IsOk)
                return Fail(checkedText.Error!);
            if ((File.Exists(file) ? File.ReadAllText(file) : "") == text)
            {
                ConfigFileWriter.Write(file, next);
                return 0;
            }
            if (attempt >= Tries)
                return Fail($"dg config: {file} kept changing while dg wrote it. Next: run the command again.");
        }
    }

    private static string? Place(TomlTable raw, string key, object value)
    {
        var parts = key.Split('.');
        var node = raw;
        for (var index = 0; index < parts.Length - 1; index++)
        {
            var part = parts[index];
            if (!node.TryGetValue(part, out var next))
            {
                var created = new TomlTable();
                node[part] = created;
                node = created;
            }
            else if (next is TomlTable table && !Dg.Core.Credentials.SecretRef.TryRead(next, out _))
                node = table;
            else
                return $"dg config: {key} is inside {part}, which is not a table. Next: run dg config edit.";
        }
        node[parts[^1]] = value;
        return null;
    }

    private static DgError PlainSecret(string file, int line, string key) =>
        new(
            file,
            line,
            key,
            $"{key} must be a credential reference {{ credential = \"<name>\" }}, got a plain value.",
            $"store the value with dg credentials set <name>, then run dg config set {key} --credential <name>."
        );
}

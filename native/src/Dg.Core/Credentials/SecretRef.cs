using System.Text.RegularExpressions;
using Dg.Core.Config;
using Dg.Core.Errors;
using Tomlyn.Model;

namespace Dg.Core.Credentials;

public readonly partial record struct SecretRef(string Credential)
{
    [GeneratedRegex(@"^[a-z0-9][a-z0-9._/-]{0,127}\z")]
    private static partial Regex NamePattern();

    public static bool IsValidName(string name) => NamePattern().IsMatch(name);

    public static bool TryRead(object? value, out SecretRef reference)
    {
        if (
            value is TomlTable { Count: 1 } table
            && table.TryGetValue("credential", out var name)
            && name is string text
            && IsValidName(text)
        )
        {
            reference = new SecretRef(text);
            return true;
        }
        reference = default;
        return false;
    }
}

public interface ICredentialStore
{
    ValueTask<string?> GetAsync(string name, CancellationToken cancellationToken);
}

public static class SecretRefResolver
{
    public static async ValueTask<ConfigResult<string>> ResolveAsync(
        SecretRef reference,
        ICredentialStore store,
        CancellationToken cancellationToken
    )
    {
        ArgumentNullException.ThrowIfNull(store);
        var value = await store.GetAsync(reference.Credential, cancellationToken);
        return value is null
            ? ConfigResult<string>.Fail(
                new DgError(
                    "",
                    null,
                    reference.Credential,
                    $"credential {reference.Credential} does not exist.",
                    $"store it with dg credentials set {reference.Credential}."
                )
            )
            : ConfigResult<string>.Ok(value);
    }
}

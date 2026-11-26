using System.Reflection;
using Dg.Core.Abstractions;
using Dg.Core.Output;

namespace Dg.Routing;

public sealed class VersionCommand(string version, OutputWriter output) : ICommand
{
    private const string SdkDefaultVersion = "1.0.0";

    public string Name => "--version";

    public static string Resolve(string? env, string? assembly)
    {
        if (!string.IsNullOrEmpty(env))
        {
            return env;
        }
        var plus = assembly?.IndexOf('+') ?? -1;
        var baked = plus >= 0 ? assembly![..plus] : assembly;
        return string.IsNullOrEmpty(baked) || baked == SdkDefaultVersion ? "dev" : baked;
    }

    public static string Current() =>
        Resolve(
            Environment.GetEnvironmentVariable("DG_BUILD_VERSION"),
            typeof(VersionCommand).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
        );

    public ValueTask<int> RunAsync(ReadOnlyMemory<string> args, CancellationToken ct)
    {
        output.WriteLine(version);
        output.Flush();
        return ValueTask.FromResult(0);
    }
}

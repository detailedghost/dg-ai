using System.Text;
using System.Text.Json;
using Dg.Core.Config;
using Dg.Core.Credentials;
using Dg.Core.Paths;
using Dg.Core.Plugins.Contract;
using Dg.Core.Plugins.Runtime;
using Microsoft.Extensions.DependencyInjection;

namespace Dg.Core.Tests.Plugins.Runtime;

internal sealed class RuntimeFixture : IAsyncDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("dgrt").FullName;
    private readonly Dictionary<string, string> _credentials = [];
    private FactoryProvider? _provider;

    public RuntimeFixture()
    {
        var env = new Dictionary<string, string?> { ["DG_HOME"] = _root };
        Paths = DgPaths.Resolve(DgPathSeams.Current(env)).Value!;
    }

    public DgPaths Paths { get; }

    public FakeApprovalSigner Signer { get; } = new();

    public string Folder(string name) => Path.Combine(Paths.DataDir, "plugins", name);

    public void Install(string name, string manifest, bool approved)
    {
        var folder = Folder(name);
        var src = Path.Combine(folder, "src");
        Directory.CreateDirectory(src);
        File.WriteAllText(Path.Combine(src, "plugin.toml"), manifest);
        File.WriteAllText(Path.Combine(src, "main.txt"), "plugin body");
        var tree = PluginApproval.HashTree(src);
        var record = ApprovalFixture.Signed(name, tree);
        ApprovalFixture.WriteRecord(folder, approved ? record : record with { ApprovedSha256 = null, Mac = null });
    }

    public void Tamper(string name) => File.AppendAllText(Path.Combine(Folder(name), "src", "main.txt"), "!");

    public void SetCredential(string name, string value) => _credentials[name] = value;

    public void Unsign(string name)
    {
        var record = PluginApprovalRecord.Read(Folder(name))!;
        ApprovalFixture.WriteRecord(Folder(name), record with { Mac = null });
    }

    public IPluginHost Host(string configToml, params IBuiltinPlugin[] builtins)
    {
        var toml = DgConfig.Parse(configToml, "config.toml").Value!;
        var services = new FakeServices();
        services.AddSingleton(Paths);
        services.AddSingleton(toml);
        services.AddSingleton<ICredentialStore>(new MapCredentials(_credentials));
        services.AddSingleton<IApprovalSigner>(Signer);
        foreach (var builtin in builtins)
            services.AddSingleton<IBuiltinPlugin>(builtin);
        services.AddPluginsRuntime();
        _provider = new FactoryProvider(services);
        return (IPluginHost)_provider.GetService(typeof(IPluginHost))!;
    }

    public async ValueTask DisposeAsync()
    {
        if (_provider is not null)
            await _provider.DisposeAsync();
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    public static PluginEnvelope HookMessage() =>
        new(
            PluginRoutes.HookDecide,
            JsonDocument.Parse("""{"event":"pre-tool-use","tool":"Bash"}""").RootElement.Clone()
        );

    private sealed class FakeServices : List<ServiceDescriptor>, IServiceCollection;

    private sealed class MapCredentials(Dictionary<string, string> map) : ICredentialStore
    {
        public ValueTask<string?> GetAsync(string name, CancellationToken cancellationToken) =>
            ValueTask.FromResult(map.GetValueOrDefault(name));
    }
}

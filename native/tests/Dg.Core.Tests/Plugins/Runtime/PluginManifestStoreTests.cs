using Dg.Core.Plugins.Runtime;

namespace Dg.Core.Tests.Plugins.Runtime;

public sealed class PluginManifestStoreTests
{
    private const string Manifest = """
        name = "scanner"
        version = "1.0.0"
        kind = "hook"
        transport = "ipc"
        endpoint = "p.sock"
        [entry]
        command = "scanner"
        """;

    [Fact]
    public async Task TryLoad_ManifestAtTheFolderRoot_IsNotRead()
    {
        await using var fixture = new RuntimeFixture();
        var store = new PluginManifestStore(fixture.Paths);
        Directory.CreateDirectory(fixture.Folder("scanner"));
        File.WriteAllText(Path.Combine(fixture.Folder("scanner"), "plugin.toml"), Manifest);

        Assert.Null(store.TryLoad("scanner"));
    }

    [Fact]
    public async Task TryLoad_ManifestInSrc_IsRead()
    {
        await using var fixture = new RuntimeFixture();
        var store = new PluginManifestStore(fixture.Paths);
        fixture.Install("scanner", Manifest, approved: false);

        Assert.Equal("scanner", store.TryLoad("scanner")?.Name);
    }
}

namespace Dg.Core.Tests.Plugins.Runtime;

internal sealed class TempFolder : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory("dgapproval").FullName;

    public void Dispose() => Directory.Delete(Path, true);
}

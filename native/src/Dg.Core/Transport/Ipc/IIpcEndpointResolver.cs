namespace Dg.Core.Transport.Ipc;

public interface IIpcEndpointResolver
{
    string SocketPath(string plugin);
}

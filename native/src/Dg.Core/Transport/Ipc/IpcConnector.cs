using System.IO.Pipes;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Principal;
using Dg.Core.Errors;

namespace Dg.Core.Transport.Ipc;

public sealed class IpcConnector(IIpcEndpointResolver resolver)
{
    public static string WindowsPipeName(string plugin) => $"dg-plugin-{plugin}";

    public ValueTask<Stream> ConnectAsync(string plugin, CancellationToken ct)
    {
        ArgumentException.ThrowIfNullOrEmpty(plugin);
        return OperatingSystem.IsWindows() ? ConnectPipeAsync(plugin, ct) : ConnectSocketAsync(resolver.SocketPath(plugin), ct);
    }

    private static async ValueTask<Stream> ConnectSocketAsync(string path, CancellationToken ct)
    {
        PeerCredentials.VerifySocketFile(path);
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            await socket.ConnectAsync(new UnixDomainSocketEndPoint(path), ct).ConfigureAwait(false);
            PeerCredentials.VerifyPeer(socket, path);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static async ValueTask<Stream> ConnectPipeAsync(string plugin, CancellationToken ct)
    {
        var name = WindowsPipeName(plugin);
        var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            await pipe.ConnectAsync(ct).ConfigureAwait(false);
            VerifyPipeAcl(pipe, name);
            return pipe;
        }
        catch
        {
            await pipe.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static void VerifyPipeAcl(NamedPipeClientStream pipe, string name)
    {
        var user = WindowsIdentity.GetCurrent().User!.Value;
        var security = pipe.GetAccessControl();
        var owner = (security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier)?.Value;
        var rules = new List<(string, bool)>();
        foreach (PipeAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            rules.Add((rule.IdentityReference.Value, rule.AccessControlType == AccessControlType.Allow));
        if (!PipeAclPolicy.IsUserOnly(user, owner, rules))
            throw new DgError(
                $@"\\.\pipe\{name}",
                null,
                "ipc-insecure",
                "pipe access list grants access to other users",
                "create the pipe with PipeOptions.CurrentUserOnly or a user-only ACL"
            ).ToException();
    }
}

using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Dg.Core.Transport.Ipc;

[SupportedOSPlatform("windows")]
public static class IpcPipeServer
{
    public static NamedPipeServerStream Create(string plugin)
    {
        ArgumentException.ThrowIfNullOrEmpty(plugin);
        using var identity = WindowsIdentity.GetCurrent();
        var user = identity.User!;
        var security = new PipeSecurity();
        foreach (var rule in PipeAclPolicy.ServerRules(user.Value))
            security.AddAccessRule(
                new PipeAccessRule(
                    new SecurityIdentifier(rule.Sid),
                    PipeAccessRights.FullControl,
                    rule.Allow ? AccessControlType.Allow : AccessControlType.Deny
                )
            );
        return NamedPipeServerStreamAcl.Create(
            IpcConnector.WindowsPipeName(plugin),
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            0,
            0,
            security
        );
    }
}

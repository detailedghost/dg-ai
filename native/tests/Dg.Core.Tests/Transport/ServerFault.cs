using System.Net.Sockets;
using System.Runtime.ExceptionServices;

namespace Dg.Core.Tests.Transport;

internal sealed class ServerFault
{
    private Exception? _fault;

    public void Record(Exception ex)
    {
        if (ex is not (OperationCanceledException or IOException or SocketException or ObjectDisposedException))
            Interlocked.CompareExchange(ref _fault, ex, null);
    }

    public void ThrowIfFaulted()
    {
        if (_fault is { } fault)
            ExceptionDispatchInfo.Capture(fault).Throw();
    }
}

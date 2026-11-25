using Dg.Core.Output;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
await using var provider = services.BuildServiceProvider(
    new ServiceProviderOptions { ValidateOnBuild = false }
);

OutputWriter.Out.WriteLine("dg");
OutputWriter.Out.Flush();
return 0;

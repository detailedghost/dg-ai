using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

if (args is not [var path])
{
    Console.Error.WriteLine("usage: Dg.SizeReport <assembly.dll>");
    return 2;
}

using var stream = File.OpenRead(path);
using var pe = new PEReader(stream);
var reader = pe.GetMetadataReader();
Console.Out.WriteLine($"{reader.GetString(reader.GetAssemblyDefinition().Name)} types={reader.TypeDefinitions.Count}");
return 0;

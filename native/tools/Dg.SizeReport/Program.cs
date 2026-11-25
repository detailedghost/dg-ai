using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text.Json;

if (args is not ["--mstat", var path, "--json"])
{
    Console.Error.WriteLine("usage: Dg.SizeReport --mstat <file.mstat> --json");
    return 2;
}

if (!File.Exists(path))
{
    Console.Error.WriteLine($"Dg.SizeReport: {path} does not exist. Publish with -p:IlcGenerateMstatFile=true and pass the dg.mstat file from the obj folder.");
    return 1;
}

using var stream = File.OpenRead(path);
using var pe = new PEReader(stream);
var reader = pe.GetMetadataReader();
var tally = new Tally(reader);

foreach (var handle in reader.MethodDefinitions)
{
    var method = reader.GetMethodDefinition(handle);
    var section = reader.GetString(method.Name);
    if (method.RelativeVirtualAddress == 0)
    {
        continue;
    }

    var il = pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ?? [];
    switch (section)
    {
        case "Methods":
            tally.Add(il, operandsToSum: 3);
            break;
        case "Types" or "FrozenObjects" or "RvaFields" or "Blobs":
            tally.Add(il, operandsToSum: 1);
            break;
    }
}

tally.Write(Console.OpenStandardOutput());
return 0;

sealed class Tally(MetadataReader reader)
{
    const byte LdToken = 0xD0;
    const byte LdStr = 0x72;
    const byte LdcI4M1 = 0x15;
    const byte LdcI4S = 0x1F;
    const byte LdcI4 = 0x20;
    const string Unknown = "(unknown)";
    const string GlobalNamespace = "(global)";

    readonly Dictionary<string, long> assemblies = [];
    readonly Dictionary<string, long> namespaces = [];
    readonly Dictionary<int, Owner> owners = [];
    readonly OwnerProvider provider = new(reader);
    long total;

    public void Add(ReadOnlySpan<byte> il, int operandsToSum)
    {
        var position = 0;
        while (position < il.Length)
        {
            var opcode = il[position++];
            if (opcode is not (LdToken or LdStr))
            {
                throw new InvalidDataException($"Unexpected IL opcode 0x{opcode:X2} at offset {position - 1} in the mstat stream.");
            }

            var token = BitConverter.ToInt32(il.Slice(position, 4));
            position += 4;
            long size = 0;
            var read = 0;
            while (position < il.Length && il[position] is not (LdToken or LdStr))
            {
                var value = ReadOperand(il, ref position);
                if (read++ < operandsToSum)
                {
                    size += value;
                }
            }

            var owner = opcode == LdStr ? new Owner("(blobs)", "(blobs)") : OwnerOf(token);
            Credit(assemblies, owner.Assembly, size);
            Credit(namespaces, owner.Namespace, size);
            total += size;
        }
    }

    public void Write(Stream output)
    {
        using var writer = new Utf8JsonWriter(output, new JsonWriterOptions { Indented = true });
        writer.WriteStartObject();
        writer.WriteNumber("totalBytes", total);
        WriteGroup(writer, "assemblies", assemblies);
        WriteGroup(writer, "namespaces", namespaces);
        writer.WriteEndObject();
        writer.Flush();
        output.WriteByte((byte)'\n');
    }

    static int ReadOperand(ReadOnlySpan<byte> il, ref int position)
    {
        var opcode = il[position++];
        switch (opcode)
        {
            case LdcI4M1:
                return -1;
            case >= 0x16 and <= 0x1E:
                return opcode - 0x16;
            case LdcI4S:
                return (sbyte)il[position++];
            case LdcI4:
                var value = BitConverter.ToInt32(il.Slice(position, 4));
                position += 4;
                return value;
            default:
                throw new InvalidDataException($"Unexpected IL operand opcode 0x{opcode:X2} at offset {position - 1} in the mstat stream.");
        }
    }

    static void Credit(Dictionary<string, long> bucket, string key, long size) =>
        bucket[key] = bucket.GetValueOrDefault(key) + size;

    static void WriteGroup(Utf8JsonWriter writer, string name, Dictionary<string, long> bucket)
    {
        writer.WriteStartObject(name);
        foreach (var (key, size) in bucket.OrderByDescending(pair => pair.Value).ThenBy(pair => pair.Key, StringComparer.Ordinal))
        {
            writer.WriteNumber(key, size);
        }

        writer.WriteEndObject();
    }

    Owner OwnerOf(int token)
    {
        if (owners.TryGetValue(token, out var cached))
        {
            return cached;
        }

        var handle = MetadataTokens.EntityHandle(token);
        var parent = handle.Kind == HandleKind.MemberReference
            ? reader.GetMemberReference((MemberReferenceHandle)handle).Parent
            : handle;
        var owner = provider.Resolve(parent);
        owners[token] = owner;
        return owner;
    }

    readonly record struct Owner(string Assembly, string Namespace);

    sealed class OwnerProvider(MetadataReader reader) : ISignatureTypeProvider<Owner, object?>
    {
        static readonly Owner Nowhere = new(Unknown, Unknown);

        public Owner Resolve(EntityHandle handle) => handle.Kind switch
        {
            HandleKind.TypeReference => Resolve((TypeReferenceHandle)handle),
            HandleKind.TypeSpecification => reader.GetTypeSpecification((TypeSpecificationHandle)handle).DecodeSignature(this, null),
            _ => Nowhere,
        };

        public Owner GetPrimitiveType(PrimitiveTypeCode typeCode) => new("System.Private.CoreLib", "System");

        public Owner GetTypeFromDefinition(MetadataReader metadata, TypeDefinitionHandle handle, byte rawTypeKind) => Nowhere;

        public Owner GetTypeFromReference(MetadataReader metadata, TypeReferenceHandle handle, byte rawTypeKind) => Resolve(handle);

        public Owner GetTypeFromSpecification(MetadataReader metadata, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
            metadata.GetTypeSpecification(handle).DecodeSignature(this, genericContext);

        public Owner GetSZArrayType(Owner elementType) => elementType;

        public Owner GetArrayType(Owner elementType, ArrayShape shape) => elementType;

        public Owner GetByReferenceType(Owner elementType) => elementType;

        public Owner GetPointerType(Owner elementType) => elementType;

        public Owner GetPinnedType(Owner elementType) => elementType;

        public Owner GetModifiedType(Owner modifier, Owner unmodifiedType, bool isRequired) => unmodifiedType;

        public Owner GetGenericInstantiation(Owner genericType, ImmutableArray<Owner> typeArguments) => genericType;

        public Owner GetFunctionPointerType(MethodSignature<Owner> signature) => Nowhere;

        public Owner GetGenericMethodParameter(object? genericContext, int index) => Nowhere;

        public Owner GetGenericTypeParameter(object? genericContext, int index) => Nowhere;

        Owner Resolve(TypeReferenceHandle handle)
        {
            var outermost = reader.GetTypeReference(handle);
            while (outermost.ResolutionScope.Kind == HandleKind.TypeReference)
            {
                outermost = reader.GetTypeReference((TypeReferenceHandle)outermost.ResolutionScope);
            }

            var ns = reader.GetString(outermost.Namespace);
            var assembly = outermost.ResolutionScope.Kind == HandleKind.AssemblyReference
                ? reader.GetString(reader.GetAssemblyReference((AssemblyReferenceHandle)outermost.ResolutionScope).Name)
                : Unknown;
            return new Owner(assembly, ns.Length == 0 ? GlobalNamespace : ns);
        }
    }
}

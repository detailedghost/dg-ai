import { gunzipSync, gzipSync } from "node:zlib";

type ByteTransform = (input: Uint8Array) => Uint8Array;

function asBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}
	throw new TypeError("Compression stream chunks must be binary data");
}

function zlibStream(transform: ByteTransform) {
	const chunks: Uint8Array[] = [];
	return new TransformStream<unknown, Uint8Array>({
		transform(chunk) {
			chunks.push(asBytes(chunk).slice());
		},
		flush(controller) {
			const input = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
			controller.enqueue(asBytes(transform(input)).slice());
		},
	});
}

class NodeCompressionStream {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<unknown>;

	constructor(format: string) {
		if (format !== "gzip") throw new TypeError(`Unsupported format: ${format}`);
		const stream = zlibStream(gzipSync);
		this.readable = stream.readable;
		this.writable = stream.writable;
	}
}

class NodeDecompressionStream {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<unknown>;

	constructor(format: string) {
		if (format !== "gzip") throw new TypeError(`Unsupported format: ${format}`);
		const stream = zlibStream(gunzipSync);
		this.readable = stream.readable;
		this.writable = stream.writable;
	}
}

if (typeof globalThis.CompressionStream === "undefined") {
	Object.defineProperty(globalThis, "CompressionStream", {
		configurable: true,
		value: NodeCompressionStream,
	});
}

if (typeof globalThis.DecompressionStream === "undefined") {
	Object.defineProperty(globalThis, "DecompressionStream", {
		configurable: true,
		value: NodeDecompressionStream,
	});
}

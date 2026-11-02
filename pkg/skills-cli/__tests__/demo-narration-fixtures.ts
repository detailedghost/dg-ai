import { createHash } from "node:crypto";

export type ZipEntry = { name: string; data: Uint8Array; unixMode?: number };

const u16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const u32 = (n: number): number[] => [
	n & 255,
	(n >>> 8) & 255,
	(n >>> 16) & 255,
	(n >>> 24) & 255,
];

export function storedZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder();
	const chunks: number[][] = [];
	const central: number[][] = [];
	let offset = 0;
	for (const { name, data, unixMode } of entries) {
		const nameBytes = [...encoder.encode(name)];
		const crc = Bun.hash.crc32(data) >>> 0;
		const local = [
			...u32(0x04034b50),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(crc),
			...u32(data.length),
			...u32(data.length),
			...u16(nameBytes.length),
			...u16(0),
			...nameBytes,
		];
		chunks.push(local, [...data]);
		central.push([
			...u32(0x02014b50),
			...u16(unixMode === undefined ? 20 : 0x0314),
			...u16(20),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(crc),
			...u32(data.length),
			...u32(data.length),
			...u16(nameBytes.length),
			...u16(0),
			...u16(0),
			...u16(0),
			...u16(0),
			...u32(unixMode === undefined ? 0 : (unixMode << 16) >>> 0),
			...u32(offset),
			...nameBytes,
		]);
		offset += local.length + data.length;
	}
	const centralSize = central.reduce((sum, part) => sum + part.length, 0);
	const end = [
		...u32(0x06054b50),
		...u16(0),
		...u16(0),
		...u16(entries.length),
		...u16(entries.length),
		...u32(centralSize),
		...u32(offset),
		...u16(0),
	];
	return Uint8Array.from([...chunks.flat(), ...central.flat(), ...end]);
}

export const sha256 = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

export const narrationZipName = (version: string): string =>
	`dg-demo-narration-${version}.zip`;

export const FIXTURE_ENTRIES: ZipEntry[] = [
	{ name: "kokoro.js", data: new TextEncoder().encode("// kokoro") },
	{
		name: "ort/ort-wasm-simd-threaded.jsep.wasm",
		data: Uint8Array.from([0, 97, 115, 109]),
	},
	{
		name: "ort/ort-wasm-simd-threaded.jsep.mjs",
		data: new TextEncoder().encode("export default 1"),
	},
];

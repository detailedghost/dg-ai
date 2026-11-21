import { deflateRawSync } from "node:zlib";

const DOS_DATE_1980 = 0x21;

export type ZipEntry = { name: string; data: Uint8Array };

const u16 = (value: number): Buffer => {
	const out = Buffer.alloc(2);
	out.writeUInt16LE(value);
	return out;
};
const u32 = (value: number): Buffer => {
	const out = Buffer.alloc(4);
	out.writeUInt32LE(value >>> 0);
	return out;
};

/** A zip with fixed timestamps, so the same inputs give the same bytes. */
export function zipEntries(entries: ZipEntry[]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBytes = Buffer.from(name);
		const packed = deflateRawSync(data);
		const crc = Bun.hash.crc32(data) >>> 0;
		const shared = [
			u16(20),
			u16(0x0800),
			u16(8),
			u16(0),
			u16(DOS_DATE_1980),
			u32(crc),
			u32(packed.length),
			u32(data.length),
			u16(nameBytes.length),
			u16(0),
		];
		const local = Buffer.concat([u32(0x04034b50), ...shared, nameBytes]);
		parts.push(local, packed);
		central.push(
			Buffer.concat([
				u32(0x02014b50),
				u16(20),
				...shared,
				u16(0),
				u16(0),
				u16(0),
				u32(0),
				u32(offset),
				nameBytes,
			]),
		);
		offset += local.length + packed.length;
	}
	const directory = Buffer.concat(central);
	return Buffer.concat([
		...parts,
		directory,
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(entries.length),
		u16(entries.length),
		u32(directory.length),
		u32(offset),
		u16(0),
	]);
}

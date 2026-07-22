/**
 * Minimal dependency-free ZIP writer (store / no compression). We bundle an
 * already-compressed webm plus a small text plan, so deflate would buy nothing —
 * store keeps this tiny and lets us run in a service worker with no libraries.
 */

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++)
		c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array };

/** Build a store-only .zip from the given entries. */
export function zipStore(entries: ZipEntry[]): Uint8Array {
	const enc = new TextEncoder();
	const local: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = enc.encode(entry.name);
		const crc = crc32(entry.data);
		const size = entry.data.length;

		const lh = new DataView(new ArrayBuffer(30));
		lh.setUint32(0, 0x04034b50, true); // local file header signature
		lh.setUint16(4, 20, true); // version needed
		lh.setUint16(6, 0, true); // flags
		lh.setUint16(8, 0, true); // method: store
		lh.setUint16(10, 0, true); // mod time
		lh.setUint16(12, 0, true); // mod date
		lh.setUint32(14, crc, true);
		lh.setUint32(18, size, true); // compressed size
		lh.setUint32(22, size, true); // uncompressed size
		lh.setUint16(26, name.length, true);
		lh.setUint16(28, 0, true); // extra len
		local.push(new Uint8Array(lh.buffer), name, entry.data);

		const ch = new DataView(new ArrayBuffer(46));
		ch.setUint32(0, 0x02014b50, true); // central dir header signature
		ch.setUint16(4, 20, true); // version made by
		ch.setUint16(6, 20, true); // version needed
		ch.setUint16(8, 0, true); // flags
		ch.setUint16(10, 0, true); // method: store
		ch.setUint16(12, 0, true); // mod time
		ch.setUint16(14, 0, true); // mod date
		ch.setUint32(16, crc, true);
		ch.setUint32(20, size, true);
		ch.setUint32(24, size, true);
		ch.setUint16(28, name.length, true);
		ch.setUint16(30, 0, true); // extra len
		ch.setUint16(32, 0, true); // comment len
		ch.setUint16(34, 0, true); // disk number
		ch.setUint16(36, 0, true); // internal attrs
		ch.setUint32(38, 0, true); // external attrs
		ch.setUint32(42, offset, true); // local header offset
		central.push(new Uint8Array(ch.buffer), name);

		offset += 30 + name.length + size;
	}

	const centralSize = central.reduce((n, b) => n + b.length, 0);
	const eocd = new DataView(new ArrayBuffer(22));
	eocd.setUint32(0, 0x06054b50, true); // end of central dir signature
	eocd.setUint16(4, 0, true); // disk number
	eocd.setUint16(6, 0, true); // disk with central dir
	eocd.setUint16(8, entries.length, true); // entries this disk
	eocd.setUint16(10, entries.length, true); // total entries
	eocd.setUint32(12, centralSize, true);
	eocd.setUint32(16, offset, true); // central dir offset
	eocd.setUint16(20, 0, true); // comment len

	const parts = [...local, ...central, new Uint8Array(eocd.buffer)];
	const total = parts.reduce((n, b) => n + b.length, 0);
	const out = new Uint8Array(total);
	let p = 0;
	for (const b of parts) {
		out.set(b, p);
		p += b.length;
	}
	return out;
}

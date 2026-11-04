import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { DgCliError } from "@dg/common";

export type ImageType = "image/png" | "image/jpeg" | "image/webp";

/** Plaintext cap for one image, before metadata is stripped. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Kind 15 `content` prefix; the ciphertext sits in the sender's outbox, not at a URL. */
export const WORMHOLE_SCHEME = "dg-wormhole:";

/** Rumor tag that marks an image the sender flagged as PHI. */
export const PHI_TAG = "dg-phi";

/** The file JSON stored on an image row: plaintext hash and size after the strip. */
export type ImageFile = { sha256: string; type: ImageType; size: number; phi?: true };

export type PreparedImage = { cipher: Buffer; x: string; tags: string[][]; content: string; file: ImageFile };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const WEBP_DROP = new Set(["EXIF", "XMP "]);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;
const GCM_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;

function notAnImage(): DgCliError {
	return new DgCliError("not an image");
}

function latin1(bytes: Buffer, start: number, end: number): string {
	return bytes.subarray(start, end).toString("latin1");
}

export function sniffImage(bytes: Uint8Array): ImageType | undefined {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 12 && latin1(buffer, 0, 4) === "RIFF" && latin1(buffer, 8, 12) === "WEBP") return "image/webp";
	return undefined;
}

function stripPng(bytes: Buffer): Buffer {
	const kept: Buffer[] = [PNG_SIGNATURE];
	for (let at = 8; ; ) {
		if (at + 12 > bytes.length) throw notAnImage();
		const end = at + 12 + bytes.readUInt32BE(at);
		if (end > bytes.length) throw notAnImage();
		const type = latin1(bytes, at + 4, at + 8);
		if (PNG_KEEP.has(type)) kept.push(bytes.subarray(at, end));
		if (type === "IEND") return Buffer.concat(kept);
		at = end;
	}
}

function isDroppedJpegMarker(marker: number): boolean {
	return (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
}

function entropyEnd(bytes: Buffer, from: number): number {
	for (let at = from; at + 1 < bytes.length; at += 1) {
		if (bytes[at] !== 0xff) continue;
		const next = bytes[at + 1] as number;
		if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) continue;
		return at;
	}
	throw notAnImage();
}

function stripJpeg(bytes: Buffer): Buffer {
	const kept: Buffer[] = [bytes.subarray(0, 2)];
	for (let at = 2; ; ) {
		if (at + 2 > bytes.length || bytes[at] !== 0xff) throw notAnImage();
		const marker = bytes[at + 1] as number;
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0xd9) {
			kept.push(bytes.subarray(at, at + 2));
			return Buffer.concat(kept);
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			kept.push(bytes.subarray(at, at + 2));
			at += 2;
			continue;
		}
		if (at + 4 > bytes.length) throw notAnImage();
		const end = at + 2 + bytes.readUInt16BE(at + 2);
		if (end > bytes.length) throw notAnImage();
		if (marker === 0xda) {
			const scanEnd = entropyEnd(bytes, end);
			kept.push(bytes.subarray(at, scanEnd));
			at = scanEnd;
			continue;
		}
		if (!isDroppedJpegMarker(marker)) kept.push(bytes.subarray(at, end));
		at = end;
	}
}

function stripWebp(bytes: Buffer): Buffer {
	const riffEnd = 8 + bytes.readUInt32LE(4);
	if (riffEnd > bytes.length) throw notAnImage();
	const kept: Buffer[] = [];
	for (let at = 12; at < riffEnd; ) {
		if (at + 8 > riffEnd) throw notAnImage();
		const fourcc = latin1(bytes, at, at + 4);
		const size = bytes.readUInt32LE(at + 4);
		const end = at + 8 + size + (size % 2);
		if (end > riffEnd) throw notAnImage();
		if (!WEBP_DROP.has(fourcc)) {
			const chunk = Buffer.from(bytes.subarray(at, end));
			if (fourcc === "VP8X" && size > 0) chunk[8] = (chunk[8] as number) & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
			kept.push(chunk);
		}
		at = end;
	}
	const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...kept]);
	const head = Buffer.alloc(8);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(body.length, 4);
	return Buffer.concat([head, body]);
}

/** Drops every metadata block (EXIF, XMP, comments, text chunks, trailing bytes) and keeps the pixels. */
export function stripMetadata(bytes: Buffer, type: ImageType): Buffer {
	switch (type) {
		case "image/png":
			return stripPng(bytes);
		case "image/jpeg":
			return stripJpeg(bytes);
		case "image/webp":
			return stripWebp(bytes);
	}
}

function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Strips, then seals under a fresh AES-256-GCM key and nonce; `cipher` is ciphertext followed by the 16-byte tag. */
export function prepareImage(source: Buffer, opts: { phi?: boolean } = {}): PreparedImage {
	const type = sniffImage(source);
	if (!type) throw notAnImage();
	const plain = stripMetadata(source, type);
	const key = randomBytes(GCM_KEY_BYTES);
	const nonce = randomBytes(GCM_NONCE_BYTES);
	const cipherer = createCipheriv("aes-256-gcm", key, nonce);
	const cipher = Buffer.concat([cipherer.update(plain), cipherer.final(), cipherer.getAuthTag()]);
	const x = sha256Hex(cipher);
	const ox = sha256Hex(plain);
	const tags = [
		["file-type", type],
		["encryption-algorithm", "aes-gcm"],
		["decryption-key", key.toString("hex")],
		["decryption-nonce", nonce.toString("hex")],
		["x", x],
		["ox", ox],
		["size", String(cipher.length)],
	];
	if (opts.phi) tags.push([PHI_TAG, "1"]);
	return {
		cipher,
		x,
		tags,
		content: `${WORMHOLE_SCHEME}${x}`,
		file: { sha256: ox, type, size: plain.length, ...(opts.phi ? { phi: true as const } : {}) },
	};
}

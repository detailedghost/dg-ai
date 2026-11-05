import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DgCliError } from "@dg/common";

export type ImageType = "image/png" | "image/jpeg" | "image/webp";

/** Plaintext cap for one image, before metadata is stripped. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Header width times height above this is refused on receive. */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** Kind 15 `content` prefix; the ciphertext sits in the sender's outbox, not at a URL. */
export const WORMHOLE_SCHEME = "dg-wormhole:";

/** Folder under `phoneRoot` that holds received images, one `<sha256>.<ext>` file each. */
export const FILES_DIR = "files";

export const IMAGE_TEXT = "[image]";
export const IMAGE_PENDING_TEXT = "[image pending]";

/** Every reason an image row may show; never raw error text, a host body, a code, or a key. */
export type ImageFailure =
	| "files are off"
	| "bad offer"
	| "too many pending"
	| "storage full"
	| "daily limit"
	| "sender offline"
	| "fetch failed"
	| "too large"
	| "hash mismatch"
	| "decrypt failed"
	| "not an image";

export function imageUnavailableText(reason: ImageFailure): string {
	return `[image unavailable: ${reason}]`;
}

/** The file JSON stored on an image row: plaintext hash and size after the strip. */
export type ImageFile = { sha256: string; type: ImageType; size: number };

/** The kind 15 fields a receive needs; `x` hashes the ciphertext, `ox` the plaintext. */
export type ImageOffer = { x: string; ox: string; size: number; key: string; nonce: string };

/** How a stored image appears in `messages`, `unread`, and the hook payload. */
export type StoredFileView = { path: string; type: ImageType; size: number; sha256: string; untrusted: true };

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
export function prepareImage(source: Buffer): PreparedImage {
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
	return {
		cipher,
		x,
		tags,
		content: `${WORMHOLE_SCHEME}${x}`,
		file: { sha256: ox, type, size: plain.length },
	};
}

const HEX64 = /^[0-9a-f]{64}$/;
const NONCE_HEX = /^(?:[0-9a-f]{24}|[0-9a-f]{32})$/;
const SIZE_TEXT = /^[1-9][0-9]{0,15}$/;
const GCM_TAG_BYTES = 16;
const EXTENSIONS: Readonly<Record<ImageType, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
/** A received image's file name; checked again on every read. */
export const FILE_NAME_PATTERN = /^[0-9a-f]{64}\.(?:png|jpg|webp)$/;

function tagValue(tags: readonly string[][], name: string): string | undefined {
	const value = tags.find((tag) => tag[0] === name)?.[1];
	return typeof value === "string" ? value : undefined;
}

/** The offer of a dg-wormhole kind 15, or undefined when any tag is malformed; `file-type` is never read. */
export function parseImageOffer(content: string, tags: readonly string[][]): ImageOffer | undefined {
	const x = tagValue(tags, "x");
	const ox = tagValue(tags, "ox");
	const key = tagValue(tags, "decryption-key");
	const nonce = tagValue(tags, "decryption-nonce");
	const size = tagValue(tags, "size");
	if (tagValue(tags, "encryption-algorithm") !== "aes-gcm") return undefined;
	if (!x || !HEX64.test(x) || !ox || !HEX64.test(ox) || !key || !HEX64.test(key)) return undefined;
	if (!nonce || !NONCE_HEX.test(nonce) || !size || !SIZE_TEXT.test(size)) return undefined;
	if (content !== `${WORMHOLE_SCHEME}${x}`) return undefined;
	const bytes = Number(size);
	if (!Number.isSafeInteger(bytes)) return undefined;
	return { x, ox, size: bytes, key, nonce };
}

function jpegPixels(bytes: Buffer): number | undefined {
	for (let at = 2; at + 4 <= bytes.length; ) {
		if (bytes[at] !== 0xff) return undefined;
		const marker = bytes[at + 1] as number;
		if (marker === 0xff) {
			at += 1;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			at += 2;
			continue;
		}
		if (marker === 0xda) return undefined;
		const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isFrame) return at + 9 <= bytes.length ? bytes.readUInt16BE(at + 5) * bytes.readUInt16BE(at + 7) : undefined;
		at += 2 + bytes.readUInt16BE(at + 2);
	}
	return undefined;
}

function webpPixels(bytes: Buffer): number | undefined {
	if (bytes.length < 20) return undefined;
	const fourcc = latin1(bytes, 12, 16);
	if (fourcc === "VP8X" && bytes.length >= 30) return (1 + bytes.readUIntLE(24, 3)) * (1 + bytes.readUIntLE(27, 3));
	if (fourcc === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
		const bits = bytes.readUInt32LE(21);
		return ((bits & 0x3fff) + 1) * (((bits >>> 14) & 0x3fff) + 1);
	}
	if (fourcc === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
		return (bytes.readUInt16LE(26) & 0x3fff) * (bytes.readUInt16LE(28) & 0x3fff);
	}
	return undefined;
}

/** Width times height from the image header, or undefined when the header does not parse. */
export function imagePixels(bytes: Buffer, type: ImageType): number | undefined {
	switch (type) {
		case "image/png":
			return bytes.length >= 24 && latin1(bytes, 12, 16) === "IHDR" ? bytes.readUInt32BE(16) * bytes.readUInt32BE(20) : undefined;
		case "image/jpeg":
			return jpegPixels(bytes);
		case "image/webp":
			return webpPixels(bytes);
	}
}

export type OpenedImage = { ok: true; plain: Buffer; type: ImageType } | { ok: false; reason: "hash mismatch" | "decrypt failed" | "not an image" | "too large" };

/** Checks x and size, decrypts in one call, checks ox, then reads the type and size from the header. */
export function openImage(cipher: Buffer, offer: ImageOffer): OpenedImage {
	if (cipher.length !== offer.size || sha256Hex(cipher) !== offer.x) return { ok: false, reason: "hash mismatch" };
	let plain: Buffer;
	try {
		const decipher = createDecipheriv("aes-256-gcm", Buffer.from(offer.key, "hex"), Buffer.from(offer.nonce, "hex"));
		decipher.setAuthTag(cipher.subarray(cipher.length - GCM_TAG_BYTES));
		plain = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - GCM_TAG_BYTES)), decipher.final()]);
	} catch {
		return { ok: false, reason: "decrypt failed" };
	}
	if (sha256Hex(plain) !== offer.ox) return { ok: false, reason: "hash mismatch" };
	const type = sniffImage(plain);
	if (!type) return { ok: false, reason: "not an image" };
	const pixels = imagePixels(plain, type);
	if (pixels === undefined) return { ok: false, reason: "not an image" };
	if (pixels > MAX_IMAGE_PIXELS) return { ok: false, reason: "too large" };
	return { ok: true, plain, type };
}

export function imageFileName(file: Pick<ImageFile, "sha256" | "type">): string | undefined {
	const name = `${file.sha256}.${EXTENSIONS[file.type] ?? ""}`;
	return FILE_NAME_PATTERN.test(name) ? name : undefined;
}

/** The file JSON of a row, or undefined when it does not parse into a known shape. */
export function parseImageFile(json: string | null): ImageFile | undefined {
	if (json === null) return undefined;
	try {
		const value = JSON.parse(json) as Partial<ImageFile>;
		if (typeof value.sha256 !== "string" || typeof value.type !== "string" || !(value.type in EXTENSIONS)) return undefined;
		if (!Number.isSafeInteger(value.size)) return undefined;
		return { sha256: value.sha256, type: value.type as ImageType, size: value.size as number };
	} catch {
		return undefined;
	}
}

/** The stored image of a received row; the path is built from `phoneRoot` on every read. */
export function storedFile(row: { direction: string; file: string | null }, phoneRoot: string): StoredFileView | undefined {
	if (row.direction !== "in") return undefined;
	const file = parseImageFile(row.file);
	const name = file && imageFileName(file);
	if (!file || !name) return undefined;
	return { path: join(phoneRoot, FILES_DIR, name), type: file.type, size: file.size, sha256: file.sha256, untrusted: true };
}

import { describe, expect, it } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import {
	FILES_DIR,
	type ImageOffer,
	imagePixels,
	MAX_IMAGE_PIXELS,
	openImage,
	parseImageOffer,
	prepareImage,
	sniffImage,
	storedFile,
	stripMetadata,
	WORMHOLE_SCHEME,
} from "../../src/phone/image";
import { jpegWithGpsExif, pngOfSize } from "./fake-image";

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngWithMetadata(): Buffer {
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", Buffer.alloc(13, 1)),
		pngChunk("tEXt", Buffer.from("Author\0Dr GPS", "latin1")),
		pngChunk("eXIf", Buffer.from("MM GPS 51.5N", "latin1")),
		pngChunk("PLTE", Buffer.alloc(3, 2)),
		pngChunk("IDAT", Buffer.from("pixels", "latin1")),
		pngChunk("IEND", Buffer.alloc(0)),
		Buffer.from("trailing GPS", "latin1"),
	]);
}

function pngChunkTypes(bytes: Buffer): string[] {
	const types: string[] = [];
	for (let at = 8; at < bytes.length; ) {
		const length = bytes.readUInt32BE(at);
		types.push(bytes.subarray(at + 4, at + 8).toString("latin1"));
		at += 12 + length;
	}
	return types;
}

function webpChunk(fourcc: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.write(fourcc, 0, "latin1");
	head.writeUInt32LE(data.length, 4);
	return Buffer.concat([head, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function webp(chunks: Buffer[]): Buffer {
	const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
	const head = Buffer.alloc(8);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(body.length, 4);
	return Buffer.concat([head, body]);
}

function webpWithMetadata(): Buffer {
	const vp8x = Buffer.alloc(10);
	vp8x[0] = 0x08 | 0x04 | 0x10;
	return webp([
		webpChunk("VP8X", vp8x),
		webpChunk("VP8 ", Buffer.from("frame", "latin1")),
		webpChunk("EXIF", Buffer.from("MM GPS 51.5N", "latin1")),
		webpChunk("XMP ", Buffer.from("<x:xmpmeta GPS/>", "latin1")),
	]);
}

describe("sniffImage", () => {
	it("reads the type from magic bytes", () => {
		expect(sniffImage(pngWithMetadata())).toBe("image/png");
		expect(sniffImage(jpegWithGpsExif())).toBe("image/jpeg");
		expect(sniffImage(webpWithMetadata())).toBe("image/webp");
	});

	it("treats SVG, text, and empty input as not an image", () => {
		expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
		expect(sniffImage(Buffer.from("hello"))).toBeUndefined();
		expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
	});
});

describe("stripMetadata", () => {
	it("removes GPS EXIF, other APP segments, comments, and trailing bytes from a JPEG", () => {
		const stripped = stripMetadata(jpegWithGpsExif(), "image/jpeg");

		expect(stripped.includes(Buffer.from("GPS", "latin1"))).toBe(false);
		expect(stripped.includes(Buffer.from("Exif", "latin1"))).toBe(false);
		expect(stripped.includes(Buffer.from([0xff, 0xe1]))).toBe(false);
		expect(stripped.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
		expect(stripped.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
		expect(stripped.includes(Buffer.from("JFIF", "latin1"))).toBe(true);
		expect(stripped.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]))).toBe(true);
	});

	it("keeps only IHDR, PLTE, tRNS, IDAT, and IEND in a PNG", () => {
		const stripped = stripMetadata(pngWithMetadata(), "image/png");

		expect(pngChunkTypes(stripped)).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
		expect(stripped.includes(Buffer.from("GPS", "latin1"))).toBe(false);
		expect(stripped.subarray(0, 8)).toEqual(PNG_SIGNATURE);
	});

	it("drops EXIF and XMP chunks from a WebP and fixes the RIFF size and VP8X flags", () => {
		const stripped = stripMetadata(webpWithMetadata(), "image/webp");

		expect(stripped.includes(Buffer.from("GPS", "latin1"))).toBe(false);
		expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8);
		expect(stripped.subarray(20, 21)[0]).toBe(0x10);
		expect(stripped.includes(Buffer.from("frame", "latin1"))).toBe(true);
	});

	it("refuses a truncated image as not an image", () => {
		const truncated = pngWithMetadata().subarray(0, 20);

		expect(() => stripMetadata(truncated, "image/png")).toThrow("not an image");
	});
});

describe("prepareImage", () => {
	it("encrypts the stripped image with AES-256-GCM and tags it the NIP-17 way", () => {
		const source = jpegWithGpsExif();
		const plain = stripMetadata(source, "image/jpeg");

		const prepared = prepareImage(source);

		const tags = Object.fromEntries(prepared.tags.map(([name, value]) => [name, value]));
		expect(prepared.tags.map(([name]) => name)).toEqual([
			"file-type",
			"encryption-algorithm",
			"decryption-key",
			"decryption-nonce",
			"x",
			"ox",
			"size",
		]);
		expect(tags["file-type"]).toBe("image/jpeg");
		expect(tags["encryption-algorithm"]).toBe("aes-gcm");
		expect(tags["decryption-key"]).toMatch(/^[0-9a-f]{64}$/);
		expect(tags["decryption-nonce"]).toMatch(/^[0-9a-f]{24}$/);
		expect(tags.x).toBe(sha256(prepared.cipher));
		expect(tags.ox).toBe(sha256(plain));
		expect(tags.ox).not.toBe(sha256(source));
		expect(tags.size).toBe(String(prepared.cipher.length));
		expect(prepared.content).toBe(`${WORMHOLE_SCHEME}${tags.x}`);
		expect(prepared.file).toEqual({ sha256: sha256(plain), type: "image/jpeg", size: plain.length });

		const key = Buffer.from(tags["decryption-key"] as string, "hex");
		const nonce = Buffer.from(tags["decryption-nonce"] as string, "hex");
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAuthTag(new Uint8Array(prepared.cipher.subarray(-16)));
		const opened = Buffer.concat([decipher.update(new Uint8Array(prepared.cipher.subarray(0, -16))), decipher.final()]);
		expect(sha256(opened)).toBe(sha256(plain));
		expect(prepared.cipher.includes(new Uint8Array(plain.subarray(0, 32)))).toBe(false);
	});

	it("uses a fresh key and nonce for every file", () => {
		const source = pngWithMetadata();

		const first = prepareImage(source);
		const second = prepareImage(source);

		const value = (tags: string[][], name: string) => tags.find(([tag]) => tag === name)?.[1];
		expect(value(first.tags, "decryption-key")).not.toBe(value(second.tags, "decryption-key"));
		expect(value(first.tags, "decryption-nonce")).not.toBe(value(second.tags, "decryption-nonce"));
		expect(value(first.tags, "x")).not.toBe(value(second.tags, "x"));
		expect(value(first.tags, "ox")).toBe(value(second.tags, "ox"));
	});

	it("rejects an SVG as not an image", () => {
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

		expect(() => prepareImage(svg)).toThrow(new DgCliError("not an image"));
	});
});

function seal(plain: Buffer, nonceBytes = 12): { cipher: Buffer; offer: ImageOffer } {
	const key = randomBytes(32);
	const nonce = randomBytes(nonceBytes);
	const cipherer = createCipheriv("aes-256-gcm", key, nonce);
	const cipher = Buffer.concat([cipherer.update(plain), cipherer.final(), cipherer.getAuthTag()]);
	return {
		cipher,
		offer: { x: sha256(cipher), ox: sha256(plain), size: cipher.length, key: key.toString("hex"), nonce: nonce.toString("hex") },
	};
}

function offerTags(offer: ImageOffer, overrides: Record<string, string> = {}): string[][] {
	const values: Record<string, string> = {
		"file-type": "image/png",
		"encryption-algorithm": "aes-gcm",
		"decryption-key": offer.key,
		"decryption-nonce": offer.nonce,
		x: offer.x,
		ox: offer.ox,
		size: String(offer.size),
		...overrides,
	};
	return [["p", "a".repeat(64)], ...Object.entries(values).map(([name, value]) => [name, value])];
}

describe("parseImageOffer", () => {
	const { offer } = seal(pngOfSize());

	it("reads the hashes, size, key, and nonce from a dg-wormhole kind 15", () => {
		expect(parseImageOffer(`${WORMHOLE_SCHEME}${offer.x}`, offerTags(offer))).toEqual(offer);
	});

	it("accepts a 16-byte nonce as well as a 12-byte one", () => {
		const wide = seal(pngOfSize(), 16).offer;

		expect(parseImageOffer(`${WORMHOLE_SCHEME}${wide.x}`, offerTags(wide))).toEqual(wide);
	});

	it("refuses an offer whose content is not dg-wormhole:<x> for the same x", () => {
		expect(parseImageOffer("https://host.example/blob", offerTags(offer))).toBeUndefined();
		expect(parseImageOffer(`${WORMHOLE_SCHEME}${"0".repeat(64)}`, offerTags(offer))).toBeUndefined();
		expect(parseImageOffer(`${WORMHOLE_SCHEME}${offer.x}/../x`, offerTags(offer))).toBeUndefined();
	});

	it("refuses bad hashes, keys, nonces, sizes, and algorithms", () => {
		const content = `${WORMHOLE_SCHEME}${offer.x}`;
		const bad: Record<string, string>[] = [
			{ x: offer.x.toUpperCase() },
			{ ox: "../../x" },
			{ ox: offer.ox.slice(1) },
			{ "decryption-key": offer.key.slice(2) },
			{ "decryption-key": `${offer.key}00` },
			{ "decryption-nonce": "00".repeat(8) },
			{ "decryption-nonce": "zz".repeat(12) },
			{ "encryption-algorithm": "aes-cbc" },
			{ size: "0" },
			{ size: "-5" },
			{ size: "12.5" },
			{ size: "9".repeat(20) },
		];
		for (const override of bad) {
			const x = override.x ?? offer.x;
			expect(parseImageOffer(override.x ? `${WORMHOLE_SCHEME}${x}` : content, offerTags(offer, override))).toBeUndefined();
		}
	});

	it("ignores a hostile file-type tag", () => {
		expect(parseImageOffer(`${WORMHOLE_SCHEME}${offer.x}`, offerTags(offer, { "file-type": "../../x" }))).toEqual(offer);
	});
});

describe("openImage", () => {
	it("decrypts and checks a sealed PNG, typed by its magic bytes", () => {
		const plain = pngOfSize();
		const { cipher, offer } = seal(plain);

		expect(openImage(cipher, offer)).toEqual({ ok: true, plain, type: "image/png" });
	});

	it("opens a 16-byte nonce image", () => {
		const plain = pngOfSize();
		const { cipher, offer } = seal(plain, 16);

		expect(openImage(cipher, offer)).toMatchObject({ ok: true, type: "image/png" });
	});

	it("reports hash mismatch when the cipher does not hash to x or its length is not size", () => {
		const { cipher, offer } = seal(pngOfSize());

		expect(openImage(cipher, { ...offer, x: "0".repeat(64) })).toEqual({ ok: false, reason: "hash mismatch" });
		expect(openImage(cipher, { ...offer, size: offer.size + 1 })).toEqual({ ok: false, reason: "hash mismatch" });
	});

	it("reports decrypt failed for a wrong key", () => {
		const { cipher, offer } = seal(pngOfSize());

		expect(openImage(cipher, { ...offer, key: randomBytes(32).toString("hex") })).toEqual({ ok: false, reason: "decrypt failed" });
	});

	it("reports hash mismatch when the plaintext does not hash to ox", () => {
		const { cipher, offer } = seal(pngOfSize());

		expect(openImage(cipher, { ...offer, ox: "0".repeat(64) })).toEqual({ ok: false, reason: "hash mismatch" });
	});

	it("reports not an image for SVG bytes even when every hash matches", () => {
		const { cipher, offer } = seal(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));

		expect(openImage(cipher, offer)).toEqual({ ok: false, reason: "not an image" });
	});

	it("reports too large for a header over the pixel cap", () => {
		const { cipher, offer } = seal(pngOfSize(8000, 6000));

		expect(openImage(cipher, offer)).toEqual({ ok: false, reason: "too large" });
	});
});

describe("imagePixels", () => {
	it("reads PNG, JPEG, and WebP header dimensions", () => {
		expect(imagePixels(pngOfSize(30, 20), "image/png")).toBe(600);
		const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 40, 0, 50, 1, 1, 0x11, 0]);
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe0, 0, 4, 0, 0]), sof, Buffer.from([0xff, 0xd9])]);
		expect(imagePixels(jpeg, "image/jpeg")).toBe(2000);
		const vp8x = Buffer.alloc(10);
		vp8x.writeUIntLE(99, 4, 3);
		vp8x.writeUIntLE(9, 7, 3);
		expect(imagePixels(webp([webpChunk("VP8X", vp8x)]), "image/webp")).toBe(1000);
		const lossless = Buffer.alloc(5);
		lossless[0] = 0x2f;
		lossless.writeUInt32LE(9 | (19 << 14), 1);
		expect(imagePixels(webp([webpChunk("VP8L", lossless)]), "image/webp")).toBe(200);
		const lossy = Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 25, 0, 4, 0]);
		expect(imagePixels(webp([webpChunk("VP8 ", lossy)]), "image/webp")).toBe(100);
	});

	it("returns undefined for a header it cannot read", () => {
		expect(imagePixels(pngOfSize().subarray(0, 20), "image/png")).toBeUndefined();
		expect(imagePixels(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toBeUndefined();
		expect(imagePixels(webp([webpChunk("VP8 ", Buffer.alloc(4))]), "image/webp")).toBeUndefined();
	});

	it("caps at about 40 megapixels", () => {
		expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
	});
});

describe("storedFile", () => {
	const sha = "a".repeat(64);

	it("builds the path from phoneRoot and marks the file untrusted", () => {
		const file = JSON.stringify({ sha256: sha, type: "image/jpeg", size: 9 });

		expect(storedFile({ direction: "in", file }, "/home/x/phone")).toEqual({
			path: join("/home/x/phone", FILES_DIR, `${sha}.jpg`),
			type: "image/jpeg",
			size: 9,
			sha256: sha,
			untrusted: true,
		});
	});

	it("shows nothing for an outgoing row, a row with no file, or a name that fails the pattern", () => {
		const good = JSON.stringify({ sha256: sha, type: "image/png", size: 9 });
		expect(storedFile({ direction: "out", file: good }, "/p")).toBeUndefined();
		expect(storedFile({ direction: "in", file: null }, "/p")).toBeUndefined();
		expect(storedFile({ direction: "in", file: JSON.stringify({ sha256: "../../etc/passwd", type: "image/png", size: 9 }) }, "/p")).toBeUndefined();
		expect(storedFile({ direction: "in", file: JSON.stringify({ sha256: sha, type: "image/svg+xml", size: 9 }) }, "/p")).toBeUndefined();
		expect(storedFile({ direction: "in", file: "not json" }, "/p")).toBeUndefined();
	});
});

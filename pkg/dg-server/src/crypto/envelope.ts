/**
 * AES-256-GCM record envelope. encryptRecord generates its own randomBytes(12)
 * — no IV parameter on the public surface — because createCipheriv silently
 * accepts 8/16/32-byte IVs without complaint (verified empirically), so both
 * directions assert the length explicitly rather than trusting the API.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// Ciphertext length reveals plaintext length exactly — an accepted side
// channel; ids/sessionId/role/timestamps stay plaintext so they're indexable.
export type CipherEnvelope = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

export type CipherBoxSeams = {
	/** Test seam only — production callers never pass this. */
	randomIv?: () => Buffer;
};

export type CipherBox = {
	encryptRecord(plaintext: string, aad: Buffer): CipherEnvelope;
	decryptRecord(
		ciphertext: Buffer,
		iv: Buffer,
		tag: Buffer,
		aad: Buffer,
	): Buffer;
};

function assertIvLength(iv: Buffer, action: "encrypt" | "decrypt"): void {
	if (iv.length !== IV_LENGTH) {
		throw new Error(
			`${action}Record: IV must be ${IV_LENGTH} bytes, got ${iv.length} — ` +
				"createCipheriv/createDecipheriv accept 8/16/32-byte IVs without complaint",
		);
	}
}

/** dataKey is the unwrapped 32-byte per-database data key, closed over by the returned box. */
export function createCipherBox(
	dataKey: Buffer,
	seams: CipherBoxSeams = {},
): CipherBox {
	const randomIv = seams.randomIv ?? (() => randomBytes(IV_LENGTH));

	function encryptRecord(plaintext: string, aad: Buffer): CipherEnvelope {
		const iv = randomIv();
		assertIvLength(iv, "encrypt");
		const cipher = createCipheriv(ALGORITHM, dataKey, iv, {
			authTagLength: TAG_LENGTH,
		});
		cipher.setAAD(aad);
		const ciphertext = Buffer.concat([
			cipher.update(plaintext, "utf8"),
			cipher.final(),
		]);
		return { ciphertext, iv, tag: cipher.getAuthTag() };
	}

	function decryptRecord(
		ciphertext: Buffer,
		iv: Buffer,
		tag: Buffer,
		aad: Buffer,
	): Buffer {
		assertIvLength(iv, "decrypt");
		const decipher = createDecipheriv(ALGORITHM, dataKey, iv, {
			authTagLength: TAG_LENGTH,
		});
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	}

	return { encryptRecord, decryptRecord };
}

export type AadFields = {
	domain: string;
	sessionId: string;
	rowId: string;
	formatVersion: number;
};

/**
 * Binds domain + format version + sessionId + rowId over immutable columns
 * only, with a distinct domain tag per encrypted field (e.g. "message-body"
 * vs "command-argv") so a ciphertext moved to another row's AAD fails loudly.
 */
export function buildAad(fields: AadFields): Buffer {
	return Buffer.from(
		JSON.stringify({
			d: fields.domain,
			s: fields.sessionId,
			r: fields.rowId,
			v: fields.formatVersion,
		}),
		"utf8",
	);
}

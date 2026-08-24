import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
	AES_GCM_ALGORITHM,
	AES_GCM_IV_BYTES,
	AES_GCM_TAG_BYTES,
} from "./constants";

export type CipherEnvelope = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

export type CipherBoxSeams = {
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
	if (iv.length !== AES_GCM_IV_BYTES) {
		throw new Error(
			`${action}Record: IV must be ${AES_GCM_IV_BYTES} bytes, got ${iv.length} — ` +
				"createCipheriv/createDecipheriv accept 8/16/32-byte IVs without complaint",
		);
	}
}

export function createCipherBox(
	dataKey: Buffer,
	seams: CipherBoxSeams = {},
): CipherBox {
	const randomIv = seams.randomIv ?? (() => randomBytes(AES_GCM_IV_BYTES));

	function encryptRecord(plaintext: string, aad: Buffer): CipherEnvelope {
		const iv = randomIv();
		assertIvLength(iv, "encrypt");
		const cipher = createCipheriv(AES_GCM_ALGORITHM, dataKey, iv, {
			authTagLength: AES_GCM_TAG_BYTES,
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
		const decipher = createDecipheriv(AES_GCM_ALGORITHM, dataKey, iv, {
			authTagLength: AES_GCM_TAG_BYTES,
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

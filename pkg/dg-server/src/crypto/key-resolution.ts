/**
 * Identity-first key resolution: read crypto_meta.key_id, collect candidates
 * from every source that answers, use the one whose fingerprint matches, and
 * REFUSE TO START when none matches — naming recorded vs. resolved identity.
 * Mint (and WRITE into the keychain when reachable) only when no crypto_meta
 * row exists yet.
 */
import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import { mintFallbackKeyFile, readFallbackKeyFile } from "./key-file";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const FINGERPRINT_SALT = Buffer.from("dg-chat-key-fingerprint-v1", "utf8");
const CRYPTO_META_FORMAT_VERSION = 1;

export type KeychainLookupResult =
	| { status: "found"; keyBase64: string }
	| { status: "absent" }
	| { status: "unreachable" };

export type KeychainBackend = {
	lookup(): Promise<KeychainLookupResult>;
	store(keyBase64: string): Promise<"stored" | "unreachable">;
	/** Honest source label for a backend that isn't really a keychain (e.g. DPAPI-over-file). Defaults to "keychain". */
	sourceLabel?: string;
};

export type CryptoMetaRow = {
	formatVersion: number;
	keyId: string;
	keySource: string;
	wrappedDataKey: Buffer;
};

export type KeyMode = "file" | "keychain" | "auto";

export type ResolveDataKeyInput = {
	existing?: CryptoMetaRow;
	keyPath: string;
	mode: KeyMode;
	keychain?: KeychainBackend;
};

export type ResolveDataKeyResult = {
	minted: boolean;
	dataKey: Buffer;
	cryptoMeta: CryptoMetaRow;
	warnings: string[];
};

export type KeyCandidateStatus = "found" | "absent" | "unreachable";
export type KeyCandidate = {
	source: string;
	status: KeyCandidateStatus;
	keyId?: string;
};

export class KeyResolutionRefusedError extends Error {
	recordedSource: string;
	recordedKeyId: string;
	candidates: KeyCandidate[];

	constructor(
		recordedSource: string,
		recordedKeyId: string,
		candidates: KeyCandidate[],
	) {
		super(
			`key resolution refused: no resolvable candidate matches recorded key_id ${recordedKeyId} (recorded source: ${recordedSource})`,
		);
		this.name = "KeyResolutionRefusedError";
		this.recordedSource = recordedSource;
		this.recordedKeyId = recordedKeyId;
		this.candidates = candidates;
	}
}

/** Deterministic, non-secret-derived identity for a KEK — never reveals the key itself. */
export function fingerprintKey(kek: Buffer): string {
	const out = hkdfSync("sha256", kek, FINGERPRINT_SALT, Buffer.alloc(0), 16);
	return Buffer.from(out).toString("hex");
}

/** Wraps the raw data key under kek: [iv(12) | tag(16) | ciphertext] in one Buffer. */
export function wrapDataKey(kek: Buffer, dataKey: Buffer): Buffer {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv(ALGORITHM, kek, iv, {
		authTagLength: TAG_LENGTH,
	});
	const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function unwrapDataKey(kek: Buffer, wrapped: Buffer): Buffer {
	const iv = wrapped.subarray(0, IV_LENGTH);
	const tag = wrapped.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
	const ciphertext = wrapped.subarray(IV_LENGTH + TAG_LENGTH);
	const decipher = createDecipheriv(ALGORITHM, kek, iv, {
		authTagLength: TAG_LENGTH,
	});
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function probeFile(keyPath: string): { candidate: KeyCandidate; kek?: Buffer } {
	try {
		const read = readFallbackKeyFile(keyPath);
		return {
			candidate: { source: "file", status: "found", keyId: read.keyId },
			kek: Buffer.from(read.keyBase64, "base64"),
		};
	} catch (err) {
		if (isEnoent(err))
			return { candidate: { source: "file", status: "absent" } };
		return { candidate: { source: "file", status: "unreachable" } };
	}
}

async function probeKeychain(
	keychain: KeychainBackend,
): Promise<{ candidate: KeyCandidate; kek?: Buffer }> {
	const source = keychain.sourceLabel ?? "keychain";
	try {
		const result = await keychain.lookup();
		if (result.status === "found") {
			const kek = Buffer.from(result.keyBase64, "base64");
			return {
				candidate: { source, status: "found", keyId: fingerprintKey(kek) },
				kek,
			};
		}
		if (result.status === "absent")
			return { candidate: { source, status: "absent" } };
		return { candidate: { source, status: "unreachable" } };
	} catch {
		return { candidate: { source, status: "unreachable" } };
	}
}

async function resolveExisting(
	existing: CryptoMetaRow,
	input: ResolveDataKeyInput,
): Promise<ResolveDataKeyResult> {
	const candidates: KeyCandidate[] = [];
	let matchedKek: Buffer | undefined;

	const probeFileSource = input.mode !== "keychain";
	const probeKeychainSource =
		input.mode !== "file" && input.keychain !== undefined;

	if (probeFileSource) {
		const { candidate, kek } = probeFile(input.keyPath);
		candidates.push(candidate);
		if (candidate.status === "found" && candidate.keyId === existing.keyId) {
			matchedKek = kek;
		}
	}
	if (probeKeychainSource) {
		// biome-ignore lint/style/noNonNullAssertion: probeKeychainSource guards input.keychain !== undefined
		const { candidate, kek } = await probeKeychain(input.keychain!);
		candidates.push(candidate);
		if (
			!matchedKek &&
			candidate.status === "found" &&
			candidate.keyId === existing.keyId
		) {
			matchedKek = kek;
		}
	}

	if (!matchedKek) {
		throw new KeyResolutionRefusedError(
			existing.keySource,
			existing.keyId,
			candidates,
		);
	}

	return {
		minted: false,
		dataKey: unwrapDataKey(matchedKek, existing.wrappedDataKey),
		cryptoMeta: existing,
		warnings: [],
	};
}

function mintViaFile(
	keyPath: string,
	dataKey: Buffer,
	warnings: string[],
): ResolveDataKeyResult {
	const kek = randomBytes(32);
	const written = mintFallbackKeyFile(keyPath, kek, fingerprintKey(kek));
	const actualKek = Buffer.from(written.keyBase64, "base64");
	return {
		minted: true,
		dataKey,
		cryptoMeta: {
			formatVersion: CRYPTO_META_FORMAT_VERSION,
			keyId: written.keyId,
			keySource: "file",
			wrappedDataKey: wrapDataKey(actualKek, dataKey),
		},
		warnings,
	};
}

async function mintViaKeychain(
	keychain: KeychainBackend,
	dataKey: Buffer,
	strict: boolean,
): Promise<ResolveDataKeyResult | undefined> {
	const kek = randomBytes(32);
	const stored = await keychain.store(kek.toString("base64"));
	if (stored !== "stored") {
		if (strict) {
			throw new Error(
				"keychain mint refused: backend reported unreachable while writing the key-encryption key",
			);
		}
		return undefined;
	}
	return {
		minted: true,
		dataKey,
		cryptoMeta: {
			formatVersion: CRYPTO_META_FORMAT_VERSION,
			keyId: fingerprintKey(kek),
			keySource: keychain.sourceLabel ?? "keychain",
			wrappedDataKey: wrapDataKey(kek, dataKey),
		},
		warnings: [],
	};
}

async function mintFresh(
	input: ResolveDataKeyInput,
): Promise<ResolveDataKeyResult> {
	const dataKey = randomBytes(32);
	const warnings: string[] = [];

	if (input.mode === "file") {
		return mintViaFile(input.keyPath, dataKey, warnings);
	}

	if (input.mode === "keychain") {
		if (!input.keychain) {
			throw new Error("DG_KEY_SOURCE=keychain requires a keychain backend");
		}
		const result = await mintViaKeychain(input.keychain, dataKey, true);
		// mintViaKeychain(strict:true) always returns a result or throws.
		return result as ResolveDataKeyResult;
	}

	// auto: a fresh mint has nothing recorded to match against, so probe
	// reachability via lookup() first rather than committing a store() blind.
	if (input.keychain) {
		let reachable = true;
		try {
			const probe = await input.keychain.lookup();
			reachable = probe.status !== "unreachable";
		} catch {
			reachable = false;
		}
		if (reachable) {
			const result = await mintViaKeychain(input.keychain, dataKey, false);
			if (result) return result;
		}
		warnings.push(
			"keychain unreachable — falling back to the file key-encryption key",
		);
	}
	return mintViaFile(input.keyPath, dataKey, warnings);
}

export async function resolveDataKey(
	input: ResolveDataKeyInput,
): Promise<ResolveDataKeyResult> {
	if (input.existing) return resolveExisting(input.existing, input);
	return mintFresh(input);
}

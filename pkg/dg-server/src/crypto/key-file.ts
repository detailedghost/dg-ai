/**
 * Fallback key-encryption-key file: O_CREAT|O_EXCL at 0600 so a concurrent
 * mint race loses to EEXIST rather than clobbering, and every read
 * fstat-and-refuses a file whose mode has drifted — writeFileSync's mode
 * option does not fix an EXISTING file's mode (verified empirically).
 */
import {
	closeSync,
	fstatSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";

const KEY_FILE_FORMAT_VERSION = 1;
const REQUIRED_MODE = 0o600;

export type FallbackKeyFile = {
	keyBase64: string;
	keyId: string;
	formatVersion: number;
};

/** fstat on the OPEN descriptor, not statSync(path) — a path-based check races a swap between check and read. */
function readKeyFileContents(path: string): FallbackKeyFile {
	const fd = openSync(path, "r");
	try {
		const mode = fstatSync(fd).mode & 0o777;
		if (mode !== REQUIRED_MODE) {
			throw new Error(
				`key file ${path} has mode ${mode.toString(8)}, expected ${REQUIRED_MODE.toString(8)} — refusing to read it`,
			);
		}
		return JSON.parse(readFileSync(fd, "utf8")) as FallbackKeyFile;
	} finally {
		closeSync(fd);
	}
}

/**
 * Mints keyPath with kek base64-encoded alongside keyId/formatVersion, mode
 * 0600. EEXIST (another mint won the race, or the file already existed) is
 * treated as a re-read, never an overwrite.
 */
export function mintFallbackKeyFile(
	keyPath: string,
	kek: Buffer,
	keyId: string,
): FallbackKeyFile {
	const contents: FallbackKeyFile = {
		keyBase64: kek.toString("base64"),
		keyId,
		formatVersion: KEY_FILE_FORMAT_VERSION,
	};
	let fd: number;
	try {
		fd = openSync(keyPath, "wx", REQUIRED_MODE);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			return readKeyFileContents(keyPath);
		}
		throw err;
	}
	try {
		writeSync(fd, Buffer.from(JSON.stringify(contents), "utf8"));
	} finally {
		closeSync(fd);
	}
	return contents;
}

/** Reads the key file, refusing (fstat-and-refuse) if its mode has drifted from 0600. */
export function readFallbackKeyFile(keyPath: string): FallbackKeyFile {
	return readKeyFileContents(keyPath);
}

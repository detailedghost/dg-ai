/** The single production write-path for staging an asset's encrypted bytes and row. */
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { CHAT_MAX_ASSET_BYTES } from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import { AssetTooLargeError, type ChatStore } from "../store";
import { getConfiguredAssetDirectory } from "./config";
import { AssetPathUnsafeError, assertFlatSegment } from "./safe-path";

export type RegisterAssetDeps = {
	paths: DgPaths;
	store: ChatStore;
};

export type RegisterAssetInput = {
	sessionId: string;
	id: string;
	filename: string;
	contentType: string;
	bytes: Buffer;
};

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const STAGE_WRITE_FLAGS =
	constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW;

function writeNoFollow(path: string, bytes: Buffer): void {
	const fd = openSync(path, STAGE_WRITE_FLAGS, 0o600);
	try {
		writeSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}

/** fstat the OPEN fd, never the path: the size bound has to apply to the very file the bytes come from. */
export function readAssetSourceFile(path: string): Buffer {
	const fd = openSync(path, constants.O_RDONLY);
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) {
			throw new Error(`${path} is not a regular file`);
		}
		if (stats.size > CHAT_MAX_ASSET_BYTES) {
			throw new AssetTooLargeError(stats.size);
		}
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

export async function registerAsset(
	deps: RegisterAssetDeps,
	input: RegisterAssetInput,
): Promise<void> {
	if (input.bytes.byteLength > CHAT_MAX_ASSET_BYTES) {
		throw new AssetTooLargeError(input.bytes.byteLength);
	}
	assertFlatSegment(input.sessionId);
	assertFlatSegment(input.id);

	const envelope = deps.store.encryptAssetBytes(
		input.sessionId,
		input.id,
		input.bytes,
	);
	const fileBytes = Buffer.concat([
		envelope.iv,
		envelope.tag,
		envelope.ciphertext,
	]);

	const root = getConfiguredAssetDirectory(deps.paths);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const rootInfo = lstatSync(root);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
		throw new AssetPathUnsafeError(`asset root ${root} is not a real directory`);
	}
	const sessionDir = join(root, input.sessionId);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	writeNoFollow(join(sessionDir, input.id), fileBytes);

	deps.store.insertAsset({
		sessionId: input.sessionId,
		id: input.id,
		filename: input.filename,
		contentType: input.contentType,
		byteLength: input.bytes.byteLength,
	});
}

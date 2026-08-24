import { closeSync, constants, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { AssetTooLargeError, CHAT_MAX_ASSET_BYTES } from "@dg/common";
import { type DgPaths, ensurePrivateDir } from "@dg/common/node";
import type { ChatStore } from "../store";
import { getConfiguredAssetDirectory } from "./config";
import { assertFlatSegment, assertRealDirectory } from "./safe-path";

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
	ensurePrivateDir(root);
	assertRealDirectory(root, `asset root ${root} is not a real directory`);
	const sessionDir = join(root, input.sessionId);
	ensurePrivateDir(sessionDir);
	assertRealDirectory(
		sessionDir,
		`asset session directory ${sessionDir} is not a real directory`,
	);
	writeNoFollow(join(sessionDir, input.id), fileBytes);

	deps.store.insertAsset({
		sessionId: input.sessionId,
		id: input.id,
		filename: input.filename,
		contentType: input.contentType,
		byteLength: input.bytes.byteLength,
	});
}

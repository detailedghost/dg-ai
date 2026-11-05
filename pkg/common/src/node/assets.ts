import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
} from "node:fs";
import { CHAT_ASSETS_PATH, CHAT_MAX_ASSET_BYTES } from "../chat-format";
import {
	ASSET_FILENAME_HEADER,
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
} from "../cli-wire";
import { AssetTooLargeError, DgCliError } from "../errors";
import { loopbackHostHeader } from "./pidfile";

/** Reads at most maxBytes from a regular file; expect pins the file identity checked earlier. */
export function readAssetSourceFile(
	path: string,
	options: {
		noFollow?: boolean;
		maxBytes?: number;
		expect?: { dev: number; ino: number };
	} = {},
): Buffer {
	const max = options.maxBytes ?? CHAT_MAX_ASSET_BYTES;
	const fd = openSync(
		path,
		constants.O_RDONLY | (options.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0),
	);
	try {
		const stats = fstatSync(fd);
		if (!stats.isFile()) {
			throw new Error(`${path} is not a regular file`);
		}
		if (
			options.expect &&
			(stats.dev !== options.expect.dev || stats.ino !== options.expect.ino)
		)
			throw new Error(`${path} changed while it was being checked`);
		if (stats.size > max) {
			throw new AssetTooLargeError(stats.size);
		}
		const limit = Math.min(stats.size, max);
		const buffer = Buffer.alloc(limit + 1);
		let total = 0;
		while (total <= limit) {
			const read = readSync(fd, buffer, total, limit + 1 - total, null);
			if (read === 0) break;
			total += read;
		}
		if (total > limit) throw new Error(`${path} grew while it was being read`);
		return buffer.subarray(0, total);
	} finally {
		closeSync(fd);
	}
}

/** Stages bytes in the dg-daemon asset store for one session and returns the asset id. */
export async function postAsset(
	session: { port: number; sessionId: string; token: string },
	filename: string,
	bytes: Buffer,
): Promise<string> {
	const resp = await fetch(
		`http://127.0.0.1:${session.port}${CHAT_ASSETS_PATH}`,
		{
			method: "POST",
			headers: {
				...loopbackHostHeader(session.port),
				[CLI_SESSION_ID_HEADER]: session.sessionId,
				[CLI_SESSION_TOKEN_HEADER]: session.token,
				[ASSET_FILENAME_HEADER]: encodeURIComponent(filename),
			},
			body: new Uint8Array(
				bytes.buffer as ArrayBuffer,
				bytes.byteOffset,
				bytes.byteLength,
			),
		},
	);
	if (!resp.ok) throw new DgCliError(await resp.text());
	const result = (await resp.json()) as { assetId?: unknown } | null;
	if (typeof result?.assetId !== "string")
		throw new DgCliError("dg-daemon returned a malformed asset upload response");
	return result.assetId;
}

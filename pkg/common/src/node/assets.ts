import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { CHAT_ASSETS_PATH, CHAT_MAX_ASSET_BYTES } from "../chat-format";
import {
	ASSET_FILENAME_HEADER,
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
} from "../cli-wire";
import { AssetTooLargeError, DgCliError } from "../errors";
import { loopbackHostHeader } from "./pidfile";

export function readAssetSourceFile(
	path: string,
	options: { noFollow?: boolean } = {},
): Buffer {
	const fd = openSync(
		path,
		constants.O_RDONLY | (options.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0),
	);
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

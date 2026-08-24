import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { CHAT_MAX_ASSET_BYTES } from "../chat-format";
import { AssetTooLargeError } from "../errors";

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

import { join } from "node:path";
import { DgCliError } from "@dg/common";
import type { DgPaths } from "@dg/common/node";

export type LinePaths = { name: string; dir: string; dbPath: string; pidPath: string; logPath: string };

export const DEFAULT_LINE = "default";
const LINE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Each line is its own number: its own key, contact, messages, and listener. */
export function linePaths(paths: DgPaths, name: string = DEFAULT_LINE): LinePaths {
	if (!LINE_PATTERN.test(name)) {
		throw new DgCliError(`line must be 1-32 lowercase letters, digits, or dashes, got "${name}"`);
	}
	const dir = join(paths.phoneFriendRoot, name);
	return {
		name,
		dir,
		dbPath: join(dir, "phone-friend.db"),
		pidPath: join(dir, "listener.pid"),
		logPath: join(dir, "listener.log"),
	};
}

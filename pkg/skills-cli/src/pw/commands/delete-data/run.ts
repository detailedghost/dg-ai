import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { isPathInside } from "@dg/common/node";
import { defaultProfileDir, profilesRoot } from "../../core/profiles";
import { resolve, stopSession } from "../../core/registry";
import type { ClientHandler } from "../../core/spec";

/** True when the profile dir, after resolving symlinks, sits strictly inside the profiles root. */
function insideRoot(profileDir: string, root: string): boolean {
	if (
		path.resolve(profileDir) === path.resolve(root) ||
		!isPathInside(profileDir, root)
	)
		return false;
	if (!existsSync(profileDir)) return true;
	const realRoot = existsSync(root) ? realpathSync(root) : path.resolve(root);
	const realDir = realpathSync(profileDir);
	return realDir !== realRoot && isPathInside(realDir, realRoot);
}

const deleteData: ClientHandler = async (args, env) => {
	const name = args.session;
	const record = resolve(name);
	if (record && record.profileDir === null) {
		env.out(`No saved data for session '${name}'.`);
		return 0;
	}
	const profileDir = record?.profileDir ?? defaultProfileDir(name);
	const root = profilesRoot();
	if (!insideRoot(profileDir, root)) {
		env.err(`Refusing to delete ${profileDir}: it is outside ${root}`);
		return 1;
	}
	if (record) await stopSession(record);
	if (!existsSync(profileDir)) {
		env.out(`No saved data for session '${name}'.`);
		return 0;
	}
	rmSync(profileDir, { recursive: true, force: true });
	env.out(`### Deleted data for session \`${name}\` (${profileDir}).`);
	return 0;
};

export default deleteData;

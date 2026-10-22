import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { isPathInside } from "@dg/common/node";
import { defaultProfileDir, profilesRoot } from "../../core/profiles";
import { resolve, stopSession } from "../../core/registry";
import type { ClientHandler } from "../../core/spec";

const deleteData: ClientHandler = async (args, env) => {
	const name = args.session;
	const record = resolve(name);
	const profileDir = record?.profileDir ?? defaultProfileDir(name);
	const root = profilesRoot();
	if (path.resolve(profileDir) === path.resolve(root) || !isPathInside(profileDir, root)) {
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

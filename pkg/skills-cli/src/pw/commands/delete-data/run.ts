import { existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { isPathInside, isWSL, resolveDgPaths } from "@dg/common/node";
import { defaultProfileDir, profilesRoot } from "../../core/profiles";
import { isProtectedSession } from "../../core/protected-session";
import {
	closeFailure,
	readAll,
	reapStale,
	resolve,
	type SessionRecord,
	stopSession,
} from "../../core/registry";
import type { ClientEnv, ClientHandler } from "../../core/spec";
import {
	isWindowsPath,
	toWslPath,
	windowsProfileDir,
} from "../../core/windows";

export type ProtectedDataDeps = {
	wsl: boolean;
	windowsProfileDir(name: string): Promise<string>;
	reapStale(): Promise<void>;
};

const realProtectedDataDeps: ProtectedDataDeps = {
	wsl: isWSL(),
	windowsProfileDir,
	reapStale: () => reapStale(),
};

/** Clears the signed-in mailbox profile and sign-in marker of a protected session in every placement. */
export async function deleteProtectedData(
	name: string,
	record: SessionRecord | null | undefined,
	env: ClientEnv,
	deps: ProtectedDataDeps = realProtectedDataDeps,
): Promise<number> {
	if (record && !(await stopSession(record))) {
		env.err(closeFailure(record));
		return 1;
	}
	await deps.reapStale();
	const retained = readAll().find((entry) => isProtectedSession(entry.name));
	if (retained) {
		env.err(closeFailure(retained));
		return 1;
	}
	const inboxDir = path.join(resolveDgPaths().stateDir, "inbox");
	const targets = [path.join(inboxDir, "proton-profile")];
	if (deps.wsl) {
		const windowsDir =
			record?.profileDir && isWindowsPath(record.profileDir)
				? record.profileDir
				: await deps.windowsProfileDir(name.toLowerCase());
		targets.push(toWslPath(windowsDir));
	}
	const deleted = targets.filter((target) => existsSync(target));
	for (const target of deleted) rmSync(target, { recursive: true, force: true });
	rmSync(path.join(inboxDir, "proton-signed-in.json"), { force: true });
	env.out(
		deleted.length === 0
			? `No saved data for session '${name}'. The sign-in marker is cleared.`
			: `### Deleted data for session \`${name}\` (${deleted.join(", ")}). The sign-in marker is cleared.`,
	);
	return 0;
}

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
	if (isProtectedSession(name))
		return deleteProtectedData(name, record, env);
	if (record && record.profileDir === null) {
		if (!(await stopSession(record))) {
			env.err(closeFailure(record));
			return 1;
		}
		env.out(`No saved data for session '${name}'.`);
		return 0;
	}
	const profileDir = record?.profileDir ?? defaultProfileDir(name);
	const root = profilesRoot();
	if (!insideRoot(profileDir, root)) {
		env.err(`Refusing to delete ${profileDir}: it is outside ${root}`);
		return 1;
	}
	if (record && !(await stopSession(record))) {
		env.err(closeFailure(record));
		return 1;
	}
	if (!existsSync(profileDir)) {
		env.out(`No saved data for session '${name}'.`);
		return 0;
	}
	rmSync(profileDir, { recursive: true, force: true });
	env.out(`### Deleted data for session \`${name}\` (${profileDir}).`);
	return 0;
};

export default deleteData;

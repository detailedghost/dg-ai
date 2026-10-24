import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError, describeError } from "@dg/common";
import { type DgPaths, realSubdirectories } from "@dg/common/node";
import { PhoneDb } from "./db";

export type JobCliResult = { code: number; stdout: string; stderr: string };
export type JobCli = (args: string[]) => Promise<JobCliResult>;

export type MigrationResult = { migrated: false } | { migrated: true };

const LINE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The old per-line database filename, from phone-friend's `line.ts`. */
function legacyDbPath(root: string, line: string): string {
	return join(root, line, "phone-friend.db");
}

/** The legacy root, when it still holds a line database and `phone.db` has not been written yet. Body (the
 * actual move) lands in slice 5; this only detects whether a migration is owed. */
export function legacyRoot(paths: DgPaths): string | undefined {
	if (existsSync(PhoneDb.path(paths))) return undefined;
	const hasLine = realSubdirectories(paths.phoneFriendRoot)
		.filter((name) => LINE_PATTERN.test(name))
		.some((name) => existsSync(legacyDbPath(paths.phoneFriendRoot, name)));
	return hasLine ? paths.phoneFriendRoot : undefined;
}

/** Every `phone`/`phone-friend` command calls this first. Slice 5 fills in the actual move; until
 * then a legacy root is left alone and every command just runs against a fresh `phone.db`. */
export function migrateIfNeeded(_paths: DgPaths): MigrationResult {
	return { migrated: false };
}

export function siblingDaemonPath(execPath: string, platform: NodeJS.Platform): string {
	const name = platform === "win32" ? "dg-daemon.exe" : "dg-daemon";
	return join(dirname(execPath), name);
}

/** The dg-daemon binary beside this dg-agent, or `dg-daemon` on PATH. */
export function resolveDaemonExecutable(
	execPath: string,
	platform: NodeJS.Platform,
	exists: (path: string) => boolean,
	which: (name: string) => string | undefined,
): string {
	const sibling = siblingDaemonPath(execPath, platform);
	if (exists(sibling)) return sibling;
	const found = which("dg-daemon");
	if (found) return found;
	throw new DgCliError("dg-daemon was not found next to dg-agent or on PATH; run `dg-skills install` and try again");
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** Run an argv with inherited env and captured output. No shell. */
export async function runArgv(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<JobCliResult> {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv, {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: envRecord(env),
		});
	} catch (err) {
		return { code: 1, stdout: "", stderr: describeError(err) };
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code: code ?? 1, stdout, stderr };
}

/** `dg-daemon job …`, using the daemon installed beside dg-agent. Slice 5 uses this to disable each
 * migrated line's old voicemail job. */
export function runDaemonJobCli(args: string[]): Promise<JobCliResult> {
	const bin = resolveDaemonExecutable(
		process.execPath,
		process.platform,
		existsSync,
		(name) => Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? undefined,
	);
	return runArgv([bin, ...args]);
}

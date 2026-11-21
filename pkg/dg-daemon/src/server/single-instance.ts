import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CHAT_PROTOCOL_VERSION, type DaemonHandle, isRecord } from "@dg/common";
import {
	type AutostartDeps,
	autostartManages,
	type DgPaths,
	defaultAutostartDeps,
	ensurePrivateDir,
	isAlive,
	isDaemonLive,
	resolveDgPaths,
	withInstallLock,
	writeFileAtomic,
} from "@dg/common/node";
import { stopDaemon } from "../commands/stop";

type Env = Record<string, string | undefined>;

export type ActiveDaemon = {
	pid: number;
	port: number;
	instanceId: string;
	home: string | null;
	stateDir: string;
	version: string;
};

export type SingleInstanceSeams = {
	env?: Env;
	recordPath?: string;
	isLive?: (record: ActiveDaemon) => Promise<boolean>;
	stop?: (paths: DgPaths) => Promise<void>;
	autostart?: AutostartDeps;
	warn?: (line: string) => void;
};

const RECORD_NAME = "active-daemon.json";

function userEnv(env: Env): Env {
	const { DG_HOME: _home, DG_PATH_FENCE: _fence, ...rest } = env;
	return rest;
}

/** The record sits in the dg state root dg would use with `DG_HOME` unset, so every home finds it. */
export function activeDaemonPath(
	env: Env = process.env,
	platform: NodeJS.Platform = process.platform,
	homeDir?: string,
): string {
	return join(resolveDgPaths({ env: userEnv(env), platform, homeDir }).daemonDir, RECORD_NAME);
}

const recordPathOf = (seams: SingleInstanceSeams): string =>
	seams.recordPath ?? activeDaemonPath(seams.env ?? process.env);

const fenced = (seams: SingleInstanceSeams): boolean => Boolean((seams.env ?? process.env).DG_PATH_FENCE);

function parseRecord(text: string): ActiveDaemon | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (
		isRecord(value) &&
		typeof value.pid === "number" &&
		typeof value.port === "number" &&
		typeof value.instanceId === "string" &&
		typeof value.stateDir === "string" &&
		typeof value.version === "string" &&
		(value.home === null || typeof value.home === "string")
	) {
		return value as ActiveDaemon;
	}
	return undefined;
}

export function readActiveDaemon(seams: SingleInstanceSeams = {}): ActiveDaemon | undefined {
	const path = recordPathOf(seams);
	if (!existsSync(path)) return undefined;
	try {
		return parseRecord(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function writeActiveDaemon(
	paths: DgPaths,
	daemon: Pick<ActiveDaemon, "pid" | "port" | "instanceId" | "version">,
	seams: SingleInstanceSeams = {},
): void {
	if (fenced(seams)) return;
	const path = recordPathOf(seams);
	const dgHome = (seams.env ?? process.env).DG_HOME;
	const record: ActiveDaemon = {
		...daemon,
		home: dgHome ? resolve(dgHome) : null,
		stateDir: paths.stateDir,
	};
	ensurePrivateDir(dirname(path));
	writeFileAtomic(path, JSON.stringify(record));
}

export function removeActiveDaemon(
	daemon: Pick<ActiveDaemon, "pid" | "instanceId">,
	seams: SingleInstanceSeams = {},
): void {
	if (fenced(seams)) return;
	const current = readActiveDaemon(seams);
	if (current?.pid !== daemon.pid || current.instanceId !== daemon.instanceId) return;
	rmSync(recordPathOf(seams), { force: true });
}

const asHandle = (record: ActiveDaemon): DaemonHandle => ({
	pid: record.pid,
	port: record.port,
	instanceId: record.instanceId,
	versions: { package: record.version, protocol: CHAT_PROTOCOL_VERSION },
});

const answers = async (record: ActiveDaemon): Promise<boolean> =>
	isAlive(record.pid) && (await isDaemonLive(asHandle(record)));

function envOfHome(base: Env, home: string | null): Env {
	const { DG_HOME: _home, ...rest } = base;
	return home === null ? rest : { ...rest, DG_HOME: home };
}

function sameStateDir(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
	const real = (path: string): string => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	};
	const fold = (path: string): string => (platform === "win32" ? path.toLowerCase() : path);
	return fold(real(a)) === fold(real(b));
}

const LOCK_TRIES = 3000;

/** Stops the live daemon another home recorded, unless a login unit would restart it. */
export async function stopOtherDaemon(paths: DgPaths, seams: SingleInstanceSeams = {}): Promise<void> {
	if (fenced(seams)) return;
	const record = readActiveDaemon(seams);
	if (!record || sameStateDir(record.stateDir, paths.stateDir)) return;
	const isLive = seams.isLive ?? answers;
	if (!(await isLive(record))) return;

	const env = userEnv(seams.env ?? process.env);
	const other = resolveDgPaths({ env: envOfHome(env, record.home) });
	const deps = seams.autostart ?? defaultAutostartDeps();
	const kind = autostartManages({ ...deps, env: envOfHome(deps.env, record.home) }, other, "dg-daemon");
	const warn = seams.warn ?? ((line: string) => console.error(line));
	const who = `the daemon of ${record.home ?? record.stateDir} (pid ${record.pid}, port ${record.port})`;
	if (kind) {
		warn(`dg daemon: ${who} runs under a ${kind} login unit, so it is left running and two daemons run`);
		return;
	}
	let failure = "";
	try {
		await (seams.stop ?? ((target: DgPaths) => stopDaemon(target, {}, {})))(other);
	} catch (err) {
		failure = `: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (await isLive(record)) {
		warn(`dg daemon: could not stop ${who}${failure}`);
		return;
	}
	warn(`dg daemon: stopped ${who} so only one runs`);
}

/** Stops another home's daemon and records this one, under one lock so concurrent starts take turns. */
export async function claimSingleInstance(
	paths: DgPaths,
	daemon: Pick<ActiveDaemon, "pid" | "port" | "instanceId" | "version">,
	seams: SingleInstanceSeams = {},
): Promise<void> {
	if (fenced(seams)) return;
	const root = dirname(recordPathOf(seams));
	ensurePrivateDir(root);
	await withInstallLock(
		root,
		async () => {
			await stopOtherDaemon(paths, seams);
			writeActiveDaemon(paths, daemon, seams);
		},
		{ tries: LOCK_TRIES },
	);
}

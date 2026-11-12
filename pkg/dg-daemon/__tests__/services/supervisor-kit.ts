import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wait } from "@dg/common";
import {
	createSupervisor,
	type ServiceStatus,
	type Supervisor,
	type SupervisorDeps,
} from "../../src/services/supervisor";

export const SLEEPER = "setInterval(() => {}, 1000);";
export const IGNORE_SIGTERM = `process.on("SIGTERM", () => {}); ${SLEEPER}`;

export type Kit = {
	root: string;
	script: (source: string) => string[];
};

export type Rig = Kit & {
	supervisor: Supervisor;
	infos: string[];
	warns: string[];
	logFile: string;
	status: (label?: string) => ServiceStatus;
	onInfo: (listener: (message: string) => void) => void;
};

const roots: string[] = [];
const supervisors: Supervisor[] = [];

export async function disposeRigs(): Promise<void> {
	await Promise.all(supervisors.splice(0).map((s) => s.stopAll()));
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
}

export function rig(
	build: (kit: Kit) => Record<string, unknown>,
	backoffMs = 25,
	extra: Partial<SupervisorDeps> = {},
): Rig {
	const root = mkdtempSync(join(tmpdir(), "dg-svc-kit-"));
	roots.push(root);
	let scripts = 0;
	const kit: Kit = {
		root,
		script: (source) => {
			const path = join(root, `script-${scripts++}.js`);
			writeFileSync(path, source);
			return [process.execPath, path];
		},
	};
	const infos: string[] = [];
	const warns: string[] = [];
	const listeners: Array<(message: string) => void> = [];
	const supervisor = createSupervisor({
		paths: {
			daemonDir: join(root, "daemon"),
			logDir: join(root, "logs"),
			grantsDir: join(root, "grants"),
		},
		daemonUrl: () => "http://127.0.0.1:1",
		loadConfig: () => ({ services: build(kit) }),
		logger: {
			info: (message: string) => {
				infos.push(message);
				for (const listener of listeners) listener(message);
			},
			warn: (message: string) => {
				warns.push(message);
			},
		},
		backoffMs: () => backoffMs,
		...extra,
	});
	supervisors.push(supervisor);
	return {
		...kit,
		supervisor,
		infos,
		warns,
		logFile: join(root, "logs", "service-bot.log"),
		onInfo: (listener) => {
			listeners.push(listener);
		},
		status: (label = "bot") =>
			supervisor
				.status()
				.find((entry) => entry.label === label) as ServiceStatus,
	};
}

export async function until(
	check: () => boolean,
	ms = 5000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await wait(20);
	}
}

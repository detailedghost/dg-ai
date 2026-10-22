import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchFixtures } from "./git-repo-fixtures";
import { CLI_ENTRY, runCli } from "./module-call";
import { SOURCE_SKILLS } from "./spec-fixtures";

export const INSTALLED_VERSION: string = JSON.parse(
	readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
).version;
export const NEWER_PLUGIN_VERSION = "99.0.0";
export const OLD_TOOL_VERSION = "0.1.0";
export const CURRENT_TOOL_VERSION = "99.0.0";

export const VERSIONED_TOOLS = [
	"git",
	"gh",
	"glab",
	"bun",
	"claude",
	"codex",
	"copilot",
] as const;

export const FORBIDDEN_TOOLS = [
	"dg-agent",
	"dg-daemon",
	"chromium",
	"chromium-browser",
	"google-chrome",
	"chrome",
	"firefox",
	"brave",
	"xdg-open",
	"curl",
	"wget",
] as const;

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	id: string;
	status: CheckStatus;
	detail: string;
	fix: string | null;
}

export interface DoctorItem {
	item: string;
	checks: DoctorCheck[];
}

export interface DoctorReport {
	items: DoctorItem[];
	ok: boolean;
}

export interface DoctorRun {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export function allowRule(sub: string): string {
	return `Bash(~/.dg/bin/dg-skills ${sub}:*)`;
}

export function versionScript(version: string): string {
	return `#!/bin/sh\necho "tool version ${version}"\n`;
}

export function recordingScript(): string {
	return `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> "$FORBIDDEN_CALL_LOG"\nexit 0\n`;
}

export function snapshotTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const visit = (path: string) => {
		for (const name of readdirSync(path).sort()) {
			const full = join(path, name);
			const stat = lstatSync(full);
			if (stat.isSymbolicLink()) out[full] = `link:${readlinkSync(full)}`;
			else if (stat.isDirectory()) {
				out[`${full}/`] = "dir";
				visit(full);
			} else out[full] = readFileSync(full).toString("base64");
		}
	};
	try {
		visit(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return out;
}

export function doctorWorld() {
	const fixtures = scratchFixtures();
	const home = fixtures.tmp("doctor-home-");
	const scratch = fixtures.tmp("doctor-scratch-");
	const state = fixtures.tmp("doctor-state-");
	const bin = fixtures.tmp("doctor-bin-");
	const logDir = fixtures.tmp("doctor-log-");
	const forbiddenLog = join(logDir, "forbidden.log");
	writeFileSync(forbiddenLog, "");

	function installTool(
		name: string,
		version: string = CURRENT_TOOL_VERSION,
		dir = bin,
	) {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, name);
		writeFileSync(path, versionScript(version));
		chmodSync(path, 0o755);
	}

	function removeTool(name: string) {
		rmSync(join(bin, name), { force: true });
	}

	function installForbiddenFakes() {
		const dgBin = join(home, ".dg", "bin");
		for (const name of FORBIDDEN_TOOLS) {
			for (const dir of [bin, dgBin]) {
				mkdirSync(dir, { recursive: true });
				const path = join(dir, name);
				writeFileSync(path, recordingScript());
				chmodSync(path, 0o755);
			}
		}
	}

	function installPlugin(version: string = INSTALLED_VERSION) {
		const skillsParent = join(
			home,
			".claude",
			"plugins",
			"cache",
			"fake-market",
			"dg",
			version,
			"plugins",
			"dg",
		);
		mkdirSync(skillsParent, { recursive: true });
		symlinkSync(SOURCE_SKILLS, join(skillsParent, "skills"));
	}

	function writeSettings(subs: string[]) {
		const dir = join(home, ".claude");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ permissions: { allow: subs.map(allowRule) } }, null, 2),
		);
	}

	function env(extra: Record<string, string | undefined> = {}) {
		const merged: Record<string, string> = {
			HOME: home,
			PATH: bin,
			AI_SCRATCH_DIR: scratch,
			AI_STATE_DIR: state,
			FORBIDDEN_CALL_LOG: forbiddenLog,
			LC_ALL: "C",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		};
		for (const [key, value] of Object.entries(extra)) {
			if (value === undefined) delete merged[key];
			else merged[key] = value;
		}
		return merged;
	}

	async function run(
		args: string[],
		extra: Record<string, string | undefined> = {},
	): Promise<DoctorRun> {
		return runCli([process.execPath, "run", CLI_ENTRY], args, {
			cwd: home,
			env: env(extra),
		});
	}

	async function report(
		items: string[] = [],
		extra: Record<string, string | undefined> = {},
	): Promise<{ run: DoctorRun; report: DoctorReport }> {
		const result = await run(["doctor", ...items, "--json"], extra);
		return { run: result, report: JSON.parse(result.stdout) as DoctorReport };
	}

	function healthy(subs: string[] = []) {
		for (const tool of VERSIONED_TOOLS) installTool(tool);
		installPlugin();
		writeSettings(subs);
		installForbiddenFakes();
	}

	return {
		home,
		scratch,
		state,
		bin,
		env,
		forbiddenLog,
		installTool,
		removeTool,
		installPlugin,
		writeSettings,
		installForbiddenFakes,
		healthy,
		run,
		report,
		forbiddenCalls(): string[] {
			return readFileSync(forbiddenLog, "utf8").split("\n").filter(Boolean);
		},
		cleanup() {
			fixtures.cleanup();
		},
	};
}

export const FAKE_SESSION_ID = "doctor-session";

export interface FakeCredentialDaemon {
	operations: string[];
	stop(): void;
}

export function startFakeCredentialDaemon(
	world: { home: string },
	names: string[],
): FakeCredentialDaemon {
	const instanceId = "doctor-fake-instance";
	const operations: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, srv) {
			const url = new URL(request.url);
			if (url.pathname === "/healthz") return Response.json({ instanceId });
			if (url.pathname === "/cli" && srv.upgrade(request)) return undefined;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as {
					requestId: string;
					operation: string;
				};
				operations.push(frame.operation);
				socket.send(
					JSON.stringify({
						type: "cli-credentials-result",
						sessionId: FAKE_SESSION_ID,
						requestId: frame.requestId,
						ok: true,
						value: frame.operation === "list" ? names.map((name) => ({ name })) : null,
					}),
				);
			},
		},
	});
	const daemonDir = join(world.home, ".dg", "daemon");
	const sessionsDir = join(world.home, ".dg", "agents", "sessions");
	mkdirSync(daemonDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(
		join(daemonDir, "daemon.pid"),
		JSON.stringify({
			pid: process.pid,
			port: server.port,
			instanceId,
			versions: { package: INSTALLED_VERSION, protocol: 1 },
		}),
	);
	writeFileSync(
		join(sessionsDir, `${FAKE_SESSION_ID}.json`),
		JSON.stringify({
			sessionId: FAKE_SESSION_ID,
			token: "doctor-fake-token",
			cwd: realpathSync(world.home),
			agentIdentity: "doctor-test",
		}),
	);
	return { operations, stop: () => server.stop(true) };
}

export function checksOf(report: DoctorReport, item: string): DoctorCheck[] {
	return report.items.find((entry) => entry.item === item)?.checks ?? [];
}

export function allChecks(report: DoctorReport): DoctorCheck[] {
	return report.items.flatMap((entry) => entry.checks);
}

export function mentions(check: DoctorCheck, pattern: RegExp): boolean {
	return pattern.test(`${check.id} ${check.detail}`);
}

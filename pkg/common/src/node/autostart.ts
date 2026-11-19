import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DgCliError } from "../errors";
import type { DgPaths } from "./dg-paths";
import { normalizeDgHome } from "./dg-paths";
import { ensurePrivateDir, writeFileAtomic } from "./fs";
import { type RunResult, runArgv } from "./process";

export type AutostartKind = "systemd" | "launchd" | "task";
export type AutostartState = { kind: AutostartKind } | { kind: "unavailable"; reason: string };
export type AutostartOutcome = { ok: true; kind: AutostartKind } | { ok: false; reason: string };

export type AutostartDeps = {
	platform: NodeJS.Platform;
	homeDir: string;
	env: Record<string, string | undefined>;
	uid: number;
	writeFile: (path: string, data: string | Uint8Array, mode?: number) => void;
	removeFile: (path: string) => void;
	fileExists: (path: string) => boolean;
	readFile?: (path: string) => string;
	run: (argv: string[]) => Promise<RunResult>;
};

export type AutostartName = "dg-phone" | "dg-daemon";

export type AutostartSpec = {
	name: AutostartName;
	argv: string[];
	dgHome?: string;
	logPath: string;
	restartPreventExitStatus?: number[];
};

const XDG_KEYS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
const DESCRIPTIONS: Record<AutostartName, string> = { "dg-phone": "dg phone listener", "dg-daemon": "dg daemon" };

const systemdUnitName = (name: AutostartName): string => `${name}.service`;
const launchdLabel = (name: AutostartName): string => `com.detailedghost.${name}`;

export function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

function environmentEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

function execStartEscape(value: string): string {
	return environmentEscape(value).replace(/\$/g, "$$$$");
}

function systemdQuoted(args: string[]): string {
	return args.map((arg) => `"${execStartEscape(arg)}"`).join(" ");
}

export function systemdUnitPath(homeDir: string, env: Record<string, string | undefined>, name: AutostartName): string {
	const configHome = env.XDG_CONFIG_HOME || join(homeDir, ".config");
	return join(configHome, "systemd", "user", systemdUnitName(name));
}

export function systemdUnitText(spec: AutostartSpec, xdgEnv: Record<string, string> = {}): string {
	const lines = [
		"[Unit]",
		`Description=${DESCRIPTIONS[spec.name]}`,
		"",
		"[Service]",
		`ExecStart=${systemdQuoted(spec.argv)}`,
		"Restart=on-failure",
		"RestartSec=5",
	];
	if (spec.restartPreventExitStatus?.length) lines.push(`RestartPreventExitStatus=${spec.restartPreventExitStatus.join(" ")}`);
	if (spec.dgHome) lines.push(`Environment="DG_HOME=${environmentEscape(spec.dgHome)}"`);
	for (const [key, value] of Object.entries(xdgEnv)) lines.push(`Environment="${key}=${environmentEscape(value)}"`);
	lines.push("", "[Install]", "WantedBy=default.target", "");
	return lines.join("\n");
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlistPath(homeDir: string, name: AutostartName): string {
	return join(homeDir, "Library", "LaunchAgents", `${launchdLabel(name)}.plist`);
}

export function launchdPlistText(spec: AutostartSpec): string {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${launchdLabel(spec.name)}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...spec.argv.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`),
		"\t</array>",
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		"\t<key>KeepAlive</key>",
		"\t<dict>",
		"\t\t<key>SuccessfulExit</key>",
		"\t\t<false/>",
		"\t</dict>",
		"\t<key>StandardOutPath</key>",
		`\t<string>${xmlEscape(spec.logPath)}</string>`,
		"\t<key>StandardErrorPath</key>",
		`\t<string>${xmlEscape(spec.logPath)}</string>`,
	];
	if (spec.dgHome) {
		lines.push(
			"\t<key>EnvironmentVariables</key>",
			"\t<dict>",
			"\t\t<key>DG_HOME</key>",
			`\t\t<string>${xmlEscape(spec.dgHome)}</string>`,
			"\t</dict>",
		);
	}
	lines.push("</dict>", "</plist>", "");
	return lines.join("\n");
}

/** CommandLineToArgvW quoting: wraps and escapes only when the argument needs it. */
function quoteWindowsArg(arg: string): string {
	if (arg.length > 0 && !/[ \t"]/.test(arg)) return arg;
	let result = '"';
	let backslashes = 0;
	for (const ch of arg) {
		if (ch === "\\") {
			backslashes += 1;
			continue;
		}
		if (ch === '"') {
			result += "\\".repeat(backslashes * 2 + 1) + '"';
			backslashes = 0;
			continue;
		}
		result += "\\".repeat(backslashes) + ch;
		backslashes = 0;
	}
	result += "\\".repeat(backslashes * 2) + '"';
	return result;
}

export function windowsTaskXmlPath(paths: DgPaths, name: AutostartName): string {
	return join(name === "dg-phone" ? paths.phoneRoot : paths.daemonDir, `${name}.task.xml`);
}

/** UTF-16 LE with a BOM, matching the `encoding="UTF-16"` declaration Task Scheduler parses. */
export function windowsTaskXmlBytes(spec: AutostartSpec): Uint8Array {
	const text = windowsTaskXml(spec);
	return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

/** Task Scheduler has no environment block, so a set `DG_HOME` is passed as `--dg-home` after `listen`. */
function windowsTaskArgs(spec: AutostartSpec): string[] {
	const args = spec.argv.slice(1);
	if (!spec.dgHome) return args;
	const runAt = args.indexOf("listen");
	const insertAt = runAt === -1 ? args.length : runAt + 1;
	args.splice(insertAt, 0, "--dg-home", spec.dgHome);
	return args;
}

export function windowsTaskXml(spec: AutostartSpec): string {
	const command = spec.argv[0] ?? "";
	const args = windowsTaskArgs(spec).map(quoteWindowsArg).join(" ");
	return [
		'<?xml version="1.0" encoding="UTF-16"?>',
		'<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
		"\t<Triggers>",
		"\t\t<LogonTrigger>",
		"\t\t\t<Enabled>true</Enabled>",
		"\t\t</LogonTrigger>",
		"\t</Triggers>",
		"\t<Settings>",
		"\t\t<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
		"\t\t<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		"\t\t<RestartOnFailure>",
		"\t\t\t<Interval>PT1M</Interval>",
		"\t\t\t<Count>10</Count>",
		"\t\t</RestartOnFailure>",
		"\t</Settings>",
		'\t<Actions Context="Author">',
		"\t\t<Exec>",
		`\t\t\t<Command>${xmlEscape(command)}</Command>`,
		`\t\t\t<Arguments>${xmlEscape(args)}</Arguments>`,
		"\t\t</Exec>",
		"\t</Actions>",
		"</Task>",
		"",
	].join("\n");
}

type AutostartLocation = { kind: AutostartKind; path: string };

function locationFor(deps: AutostartDeps, paths: DgPaths, name: AutostartName): AutostartLocation | undefined {
	if (deps.platform === "linux") return { kind: "systemd", path: systemdUnitPath(deps.homeDir, deps.env, name) };
	if (deps.platform === "darwin") return { kind: "launchd", path: launchdPlistPath(deps.homeDir, name) };
	if (deps.platform === "win32") return { kind: "task", path: windowsTaskXmlPath(paths, name) };
	return undefined;
}

function unitTextFor(kind: AutostartKind, spec: AutostartSpec, xdgEnv: Record<string, string>): string {
	if (kind === "systemd") return systemdUnitText(spec, xdgEnv);
	if (kind === "launchd") return launchdPlistText(spec);
	return windowsTaskXml(spec);
}

async function installSystemd(deps: AutostartDeps, name: AutostartName, path: string): Promise<AutostartOutcome> {
	const reload = await deps.run(["systemctl", "--user", "daemon-reload"]);
	if (reload.code !== 0) {
		deps.removeFile(path);
		return { ok: false, reason: firstLine(reload.stderr) || "systemctl --user daemon-reload failed" };
	}
	const unit = systemdUnitName(name);
	const enable = await deps.run(["systemctl", "--user", "enable", "--now", unit]);
	if (enable.code !== 0) {
		deps.removeFile(path);
		throw new DgCliError(`systemctl --user enable --now ${unit} failed: ${firstLine(enable.stderr) || firstLine(enable.stdout)}`);
	}
	return { ok: true, kind: "systemd" };
}

async function installLaunchd(deps: AutostartDeps, name: AutostartName, path: string): Promise<AutostartOutcome> {
	await deps.run(["launchctl", "bootout", `gui/${deps.uid}/${launchdLabel(name)}`]);
	const bootstrap = await deps.run(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
	if (bootstrap.code !== 0) {
		deps.removeFile(path);
		return { ok: false, reason: firstLine(bootstrap.stderr) || "launchctl bootstrap failed" };
	}
	return { ok: true, kind: "launchd" };
}

async function installTask(deps: AutostartDeps, name: AutostartName, path: string): Promise<AutostartOutcome> {
	await deps.run(["schtasks", "/End", "/TN", name]);
	const create = await deps.run(["schtasks", "/Create", "/TN", name, "/XML", path, "/F"]);
	if (create.code !== 0) {
		deps.removeFile(path);
		return { ok: false, reason: firstLine(create.stderr) || "schtasks /Create failed" };
	}
	const run = await deps.run(["schtasks", "/Run", "/TN", name]);
	if (run.code !== 0) {
		const deleted = await deps.run(["schtasks", "/Delete", "/TN", name, "/F"]);
		if (deleted.code === 0) deps.removeFile(path);
		throw new DgCliError(`schtasks /Run /TN ${name} failed: ${firstLine(run.stderr) || firstLine(run.stdout)}`);
	}
	return { ok: true, kind: "task" };
}

/** Commands that restart an already-installed unit without replacing it with a detached process. */
export function managedRestartCommands(kind: AutostartKind, uid: number, name: AutostartName, unitPath?: string): string[][] {
	if (kind === "systemd") return [["systemctl", "--user", "restart", systemdUnitName(name)]];
	if (kind === "launchd") {
		const target = `gui/${uid}/${launchdLabel(name)}`;
		const kickstart = ["launchctl", "kickstart", "-k", target];
		if (name !== "dg-daemon") return [kickstart];
		if (!unitPath) throw new Error("managedRestartCommands: launchd dg-daemon needs the plist path");
		return [["launchctl", "bootstrap", `gui/${uid}`, unitPath], kickstart];
	}
	return [
		["schtasks", "/End", "/TN", name],
		["schtasks", "/Run", "/TN", name],
	];
}

/** Commands that stop a unit for good, so a kill does not make the manager start it again. */
export function managedStopCommands(kind: AutostartKind, uid: number, name: AutostartName): string[][] {
	if (kind === "systemd") return [["systemctl", "--user", "stop", systemdUnitName(name)]];
	if (kind === "launchd") return [["launchctl", "bootout", `gui/${uid}/${launchdLabel(name)}`]];
	return [["schtasks", "/End", "/TN", name]];
}

function assertNoControlCharacters(spec: AutostartSpec, xdgEnv: Record<string, string>): void {
	const named = { ...(spec.dgHome ? { DG_HOME: spec.dgHome } : {}), ...xdgEnv };
	const values = [...Object.entries(named), ...spec.argv.map((arg, index) => [`argument ${index}`, arg] as const)];
	for (const [label, value] of values) {
		if (CONTROL_CHARACTER.test(value)) throw new DgCliError(`${label} holds a control character; fix it and run the command again`);
	}
}

/** Writes the manager's file and runs its install commands; a failed first command removes the file and reports the manager unavailable, a later one throws. */
export async function installAutostart(deps: AutostartDeps, paths: DgPaths, spec: AutostartSpec): Promise<AutostartOutcome> {
	const location = locationFor(deps, paths, spec.name);
	if (!location) return { ok: false, reason: `unsupported platform "${deps.platform}"` };
	const xdgEnv = spec.name === "dg-phone" ? {} : setXdgEnv(deps.env);
	assertNoControlCharacters(spec, xdgEnv);
	const payload = location.kind === "task" ? windowsTaskXmlBytes(spec) : unitTextFor(location.kind, spec, xdgEnv);
	deps.writeFile(location.path, payload, 0o600);
	if (location.kind === "systemd") return installSystemd(deps, spec.name, location.path);
	if (location.kind === "launchd") return installLaunchd(deps, spec.name, location.path);
	return installTask(deps, spec.name, location.path);
}

function removeCommandsFor(kind: AutostartKind, deps: AutostartDeps, name: AutostartName): string[][] {
	if (kind === "systemd") return [["systemctl", "--user", "disable", "--now", systemdUnitName(name)]];
	if (kind === "launchd") return [["launchctl", "bootout", `gui/${deps.uid}/${launchdLabel(name)}`]];
	return [
		["schtasks", "/End", "/TN", name],
		["schtasks", "/Delete", "/TN", name, "/F"],
	];
}

/** Best-effort: runs every manager command, removes the file, and reports "absent" when nothing is installed. */
export async function removeAutostart(deps: AutostartDeps, paths: DgPaths, name: AutostartName): Promise<"removed" | "absent"> {
	const location = locationFor(deps, paths, name);
	if (!location || !deps.fileExists(location.path)) return "absent";
	for (const argv of removeCommandsFor(location.kind, deps, name)) {
		await deps.run(argv);
	}
	deps.removeFile(location.path);
	return "removed";
}

export function formatAutostartState(state: AutostartState | undefined): string | null {
	if (!state) return null;
	return state.kind === "unavailable" ? `unavailable: ${state.reason}` : state.kind;
}

function setXdgEnv(env: Record<string, string | undefined>): Record<string, string> {
	const set: Record<string, string> = {};
	for (const key of XDG_KEYS) {
		const value = env[key];
		if (value) set[key] = value;
	}
	return set;
}

/** The kind of the unit file that exists for `name`; runs no command. */
export function autostartInstalled(deps: AutostartDeps, paths: DgPaths, name: AutostartName): AutostartKind | undefined {
	const location = locationFor(deps, paths, name);
	return location && deps.fileExists(location.path) ? location.kind : undefined;
}

export function autostartUnitPath(deps: AutostartDeps, paths: DgPaths, name: AutostartName): string | undefined {
	return locationFor(deps, paths, name)?.path;
}

function unescapeEnvironment(value: string): string {
	return value.replace(/\\([\\"])|%%/g, (match, escaped: string | undefined) => escaped ?? "%");
}

function unescapeXml(value: string): string {
	return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function systemdRecorded(text: string): Record<string, string> {
	const recorded: Record<string, string> = {};
	for (const match of text.matchAll(/^Environment="([A-Z_]+)=(.*)"$/gm)) {
		recorded[match[1] as string] = unescapeEnvironment(match[2] as string);
	}
	return recorded;
}

function launchdRecorded(text: string): Record<string, string> {
	const recorded: Record<string, string> = {};
	for (const match of text.matchAll(/<key>(DG_HOME)<\/key>\s*<string>([^<]*)<\/string>/g)) {
		recorded[match[1] as string] = unescapeXml(match[2] as string);
	}
	return recorded;
}

function absoluteDgHome(value: string | undefined, platform: NodeJS.Platform): string | undefined {
	if (!value) return undefined;
	const env: Record<string, string | undefined> = { DG_HOME: value };
	normalizeDgHome(env, platform);
	return env.DG_HOME;
}

/** The unit kind for `name`, only when the unit records the caller's `DG_HOME` and `XDG_*_HOME`. */
export function autostartManages(deps: AutostartDeps, paths: DgPaths, name: AutostartName): AutostartKind | undefined {
	const location = locationFor(deps, paths, name);
	if (!location || !deps.fileExists(location.path)) return undefined;
	let recorded: Record<string, string> = {};
	if (location.kind !== "task") {
		let text: string;
		try {
			text = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(location.path);
		} catch {
			return undefined;
		}
		recorded = location.kind === "systemd" ? systemdRecorded(text) : launchdRecorded(text);
	}
	if (absoluteDgHome(recorded.DG_HOME, deps.platform) !== absoluteDgHome(deps.env.DG_HOME, deps.platform)) return undefined;
	if (location.kind === "systemd") {
		for (const key of XDG_KEYS) {
			if ((recorded[key] || undefined) !== (deps.env[key] || undefined)) return undefined;
		}
	}
	return location.kind;
}

export function defaultAutostartDeps(): AutostartDeps {
	return {
		platform: process.platform,
		homeDir: homedir(),
		env: process.env,
		uid: process.getuid?.() ?? 0,
		writeFile: (path, data, mode) => {
			ensurePrivateDir(dirname(path));
			writeFileAtomic(path, typeof data === "string" ? data : Buffer.from(data), mode);
		},
		removeFile: (path) => rmSync(path, { force: true }),
		fileExists: existsSync,
		readFile: (path) => readFileSync(path, "utf8"),
		run: runArgv,
	};
}

import { DgCliError } from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import { join } from "node:path";

export type AutostartKind = "systemd" | "launchd" | "task";
export type AutostartState = { kind: AutostartKind } | { kind: "unavailable"; reason: string };
export type AutostartOutcome = { ok: true; kind: AutostartKind } | { ok: false; reason: string };

export type RunResult = { code: number; stdout: string; stderr: string };

export type AutostartDeps = {
	platform: NodeJS.Platform;
	homeDir: string;
	env: Record<string, string | undefined>;
	uid: number;
	writeFile: (path: string, text: string, mode?: number) => void;
	removeFile: (path: string) => void;
	fileExists: (path: string) => boolean;
	run: (argv: string[]) => Promise<RunResult>;
};

export type AutostartSpec = {
	argv: string[];
	dgHome?: string;
	logPath: string;
};

const SERVICE_NAME = "dg-phone";
const SYSTEMD_UNIT = `${SERVICE_NAME}.service`;
const LAUNCHD_LABEL = "com.detailedghost.dg-phone";
const TASK_NAME = SERVICE_NAME;

function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

function systemdEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
}

function systemdQuoted(args: string[]): string {
	return args.map((arg) => `"${systemdEscape(arg)}"`).join(" ");
}

export function systemdUnitPath(homeDir: string, env: Record<string, string | undefined>): string {
	const configHome = env.XDG_CONFIG_HOME || join(homeDir, ".config");
	return join(configHome, "systemd", "user", SYSTEMD_UNIT);
}

export function systemdUnitText(spec: AutostartSpec): string {
	const lines = [
		"[Unit]",
		"Description=dg phone listener",
		"",
		"[Service]",
		`ExecStart=${systemdQuoted(spec.argv)}`,
		"Restart=on-failure",
		"RestartSec=5",
	];
	if (spec.dgHome) lines.push(`Environment="DG_HOME=${systemdEscape(spec.dgHome)}"`);
	lines.push("", "[Install]", "WantedBy=default.target", "");
	return lines.join("\n");
}

function xmlEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlistPath(homeDir: string): string {
	return join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function launchdPlistText(spec: AutostartSpec): string {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${LAUNCHD_LABEL}</string>`,
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

export function windowsTaskXmlPath(paths: DgPaths): string {
	return join(paths.phoneRoot, "dg-phone.task.xml");
}

export function windowsTaskXml(spec: AutostartSpec): string {
	const [command, ...rest] = spec.argv;
	const args = rest.map(quoteWindowsArg).join(" ");
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

function locationFor(deps: AutostartDeps, paths: DgPaths): AutostartLocation | undefined {
	if (deps.platform === "linux") return { kind: "systemd", path: systemdUnitPath(deps.homeDir, deps.env) };
	if (deps.platform === "darwin") return { kind: "launchd", path: launchdPlistPath(deps.homeDir) };
	if (deps.platform === "win32") return { kind: "task", path: windowsTaskXmlPath(paths) };
	return undefined;
}

function unitTextFor(kind: AutostartKind, spec: AutostartSpec): string {
	if (kind === "systemd") return systemdUnitText(spec);
	if (kind === "launchd") return launchdPlistText(spec);
	return windowsTaskXml(spec);
}

async function installSystemd(deps: AutostartDeps, path: string): Promise<AutostartOutcome> {
	const reload = await deps.run(["systemctl", "--user", "daemon-reload"]);
	if (reload.code !== 0) {
		deps.removeFile(path);
		return { ok: false, reason: firstLine(reload.stderr) || "systemctl --user daemon-reload failed" };
	}
	const enable = await deps.run(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT]);
	if (enable.code !== 0) {
		throw new DgCliError(`systemctl --user enable --now ${SYSTEMD_UNIT} failed: ${firstLine(enable.stderr) || enable.stdout}`);
	}
	return { ok: true, kind: "systemd" };
}

async function installLaunchd(deps: AutostartDeps, path: string): Promise<AutostartOutcome> {
	await deps.run(["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]);
	const bootstrap = await deps.run(["launchctl", "bootstrap", `gui/${deps.uid}`, path]);
	if (bootstrap.code !== 0) {
		deps.removeFile(path);
		return { ok: false, reason: firstLine(bootstrap.stderr) || "launchctl bootstrap failed" };
	}
	return { ok: true, kind: "launchd" };
}

async function installTask(deps: AutostartDeps, path: string): Promise<AutostartOutcome> {
	await deps.run(["schtasks", "/End", "/TN", TASK_NAME]);
	const create = await deps.run(["schtasks", "/Create", "/TN", TASK_NAME, "/XML", path, "/F"]);
	if (create.code !== 0) {
		deps.removeFile(path);
		return { ok: false, reason: firstLine(create.stderr) || "schtasks /Create failed" };
	}
	const run = await deps.run(["schtasks", "/Run", "/TN", TASK_NAME]);
	if (run.code !== 0) {
		throw new DgCliError(`schtasks /Run /TN ${TASK_NAME} failed: ${firstLine(run.stderr) || run.stdout}`);
	}
	return { ok: true, kind: "task" };
}

/**
 * Writes the service manager's own file, then runs its install commands. The first command's
 * failure means the manager itself is unavailable here (no systemd user bus, e.g. WSL without
 * systemd, or a container): the file is removed and the caller falls back to a detached spawn. A
 * later command's failure means something is actually broken, not merely unavailable, and throws.
 */
export async function installAutostart(deps: AutostartDeps, paths: DgPaths, spec: AutostartSpec): Promise<AutostartOutcome> {
	const location = locationFor(deps, paths);
	if (!location) return { ok: false, reason: `unsupported platform "${deps.platform}"` };
	deps.writeFile(location.path, unitTextFor(location.kind, spec), 0o600);
	if (location.kind === "systemd") return installSystemd(deps, location.path);
	if (location.kind === "launchd") return installLaunchd(deps, location.path);
	return installTask(deps, location.path);
}

function removeCommandsFor(kind: AutostartKind, deps: AutostartDeps): string[][] {
	if (kind === "systemd") return [["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]];
	if (kind === "launchd") return [["launchctl", "bootout", `gui/${deps.uid}/${LAUNCHD_LABEL}`]];
	return [
		["schtasks", "/End", "/TN", TASK_NAME],
		["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
	];
}

/** Best-effort: every manager command runs regardless of the others' results, since the file is
 * being removed either way. Reports `"absent"` without touching anything when nothing is installed. */
export async function removeAutostart(deps: AutostartDeps, paths: DgPaths): Promise<"removed" | "absent"> {
	const location = locationFor(deps, paths);
	if (!location || !deps.fileExists(location.path)) return "absent";
	for (const argv of removeCommandsFor(location.kind, deps)) {
		await deps.run(argv);
	}
	deps.removeFile(location.path);
	return "removed";
}

export function formatAutostartState(state: AutostartState | undefined): string | null {
	if (!state) return null;
	return state.kind === "unavailable" ? `unavailable: ${state.reason}` : state.kind;
}

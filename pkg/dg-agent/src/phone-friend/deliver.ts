import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError, describeError, parseEvery } from "@dg/common";
import { type DgPaths, readSessionIdentities } from "@dg/common/node";
import { DEFAULT_LINE } from "./line";

/** Repo path of the only copy of the phone-friend safety rules. */
export const PHONE_FRIEND_SAFETY_REF =
	"plugins/dg/skills/phone-friend/references/safety.md";

/** Default cadence for the voicemail delivery job, in `job add --every` form. */
export const DEFAULT_DELIVERY_EVERY = "1m";

export type JobCliResult = { code: number; stdout: string; stderr: string };

/** dg-daemon's `job add` "label already taken" error text; see pkg/dg-daemon/src/commands/jobs.ts. */
export const JOB_EXISTS_MARKER = "already exists";

/** dg-daemon's `job enable`/`job disable` "unknown label" error text; see pkg/dg-daemon/src/commands/jobs.ts. */
export const JOB_NOT_FOUND_MARKER = "no job labelled";

export type JobCli = (args: string[]) => Promise<JobCliResult>;

export type DeliveryTarget = {
	line: string;
	every: string;
	notifyIdentity: string;
	cwd: string;
};

type IdentityRecord = { sessionId: string; cwd: string; agentIdentity: string };

/** Label of the one scheduled job that delivers a line's voicemail. */
export function deliveryLabel(line: string): string {
	return `phone-friend:${line}`;
}

/** Argv stored on the daemon job. The default line omits `--line`. */
export function deliveryArgv(line: string): string[] {
	if (line === DEFAULT_LINE) return ["dg-agent", "phone-friend", "voicemail"];
	return ["dg-agent", "phone-friend", "--line", line, "voicemail"];
}

/** Feed `title` for one voicemail line. The job runner rejects an empty title. */
export function voicemailTitle(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 0 ? trimmed : "(empty)";
}

/** Voicemail JSON the job runner can read: the message, plus a non-empty `title`. */
export function voicemailLine<T extends { text: string }>(
	message: T,
	extra?: Record<string, unknown>,
): T & Record<string, unknown> & { title: string } {
	return { ...message, ...extra, title: voicemailTitle(message.text) };
}

function samePath(realpath: (path: string) => string, left: string, right: string): boolean {
	try {
		return realpath(left) === right;
	} catch {
		return false;
	}
}

/** The agent identity a delivery job should notify for this session or directory. */
export function identityForSession(
	records: readonly IdentityRecord[],
	options: { sessionId?: string; cwd: string },
	realpath: (path: string) => string,
): string {
	const usable = records.filter((record) => record.agentIdentity.trim().length > 0);
	if (options.sessionId !== undefined) {
		const match = usable.find((record) => record.sessionId === options.sessionId);
		if (!match) {
			throw new DgCliError(
				`no active dg session ${options.sessionId} to notify; pass --notify <identity>`,
			);
		}
		return match.agentIdentity;
	}
	let here: string;
	try {
		here = realpath(options.cwd);
	} catch {
		throw new DgCliError(
			"no active dg session in this directory to notify; pass --notify <identity>",
		);
	}
	const matches = usable.filter((record) => samePath(realpath, record.cwd, here));
	if (matches.length === 1) return matches[0].agentIdentity;
	if (matches.length === 0) {
		throw new DgCliError(
			"no active dg session in this directory to notify; pass --notify <identity> or run dg-agent start",
		);
	}
	throw new DgCliError(
		"more than one dg session is active in this directory; pass --session or --notify <identity>",
	);
}

export function identityFromDaemon(paths: DgPaths, session?: string): string {
	return identityForSession(
		readSessionIdentities(paths.dbPath),
		{ sessionId: session, cwd: process.cwd() },
		realpathSync,
	);
}

function outputOf(result: JobCliResult): string {
	return `${result.stderr}\n${result.stdout}`;
}

function failureText(result: JobCliResult, fallback: string): string {
	const text = outputOf(result).trim();
	return text.length > 0 ? text : fallback;
}

/** Register the line's voicemail job, or re-enable it when that label already exists. */
export async function enableDelivery(input: DeliveryTarget, run: JobCli): Promise<"added" | "enabled"> {
	const every = input.every.trim();
	parseEvery(every);
	const notifyIdentity = input.notifyIdentity.trim();
	if (notifyIdentity.length === 0) {
		throw new DgCliError("deliver on: --notify needs an agent identity");
	}
	const label = deliveryLabel(input.line);
	const added = await run([
		"job",
		"add",
		"--label",
		label,
		"--every",
		every,
		"--cwd",
		input.cwd,
		"--notify",
		notifyIdentity,
		"--",
		...deliveryArgv(input.line),
	]);
	if (added.code === 0) return "added";
	if (!outputOf(added).includes(JOB_EXISTS_MARKER)) {
		throw new DgCliError(failureText(added, `could not schedule ${label}`));
	}
	const enabled = await run(["job", "enable", label]);
	if (enabled.code !== 0) {
		throw new DgCliError(failureText(enabled, `could not enable ${label}`));
	}
	return "enabled";
}

/** Pause the line's voicemail job. Missing jobs are already off. */
export async function disableDelivery(line: string, run: JobCli): Promise<"disabled" | "absent"> {
	const label = deliveryLabel(line);
	const result = await run(["job", "disable", label]);
	if (result.code === 0) return "disabled";
	if (outputOf(result).includes(JOB_NOT_FOUND_MARKER)) return "absent";
	throw new DgCliError(failureText(result, `could not disable ${label}`));
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
	throw new DgCliError(
		"dg-daemon was not found next to dg-agent or on PATH; run `dg-skills install` and try again",
	);
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** Run an argv with inherited env and captured output. No shell. */
export async function runArgv(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
): Promise<JobCliResult> {
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

/** `dg-daemon job …`, using the daemon installed beside dg-agent. */
export function runDaemonJobCli(args: string[]): Promise<JobCliResult> {
	const bin = resolveDaemonExecutable(
		process.execPath,
		process.platform,
		existsSync,
		(name) => Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? undefined,
	);
	return runArgv([bin, ...args]);
}

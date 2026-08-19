import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { SessionRegistry } from "../session/registry";
import type { ChatStore } from "../store";
import { substituteArgv } from "./argv";
import { executeCommand } from "./exec";
import { type CommandEntryWithLimits, resolveLimits } from "./limits";
import type { DispatchScheduler } from "./scheduler";

export { resolveSubagentMention } from "./mentions";
export { DispatchScheduler } from "./scheduler";

export type CommandResultPayload =
	| { ok: true; output: string }
	| { ok: false; error: string; output?: string };

export type DispatchDeps = {
	store: ChatStore;
	registry: SessionRegistry;
	scheduler: DispatchScheduler;
};

/**
 * Resolves commandLabel -> argv from the manifest published for THIS
 * session, substitutes params, admits against the scheduler's bounds, then
 * spawns. sessionId here has already passed authorizeFrame against the
 * socket's capability map — this function never trusts an unchecked field.
 */
export async function dispatchCommand(
	sessionId: string,
	commandLabel: string,
	params: Record<string, unknown>,
	deps: DispatchDeps,
): Promise<CommandResultPayload> {
	const manifest = deps.store.getCommandManifest(sessionId) as
		| CommandEntryWithLimits[]
		| undefined;
	const entry = manifest?.find((candidate) => candidate.label === commandLabel);
	if (!entry) {
		return {
			ok: false,
			error: `no published command named "${commandLabel}" for this session`,
		};
	}

	const session = deps.registry.get(sessionId);
	if (!session) {
		return { ok: false, error: "session is no longer active" };
	}
	if (!existsSync(session.cwd)) {
		return {
			ok: false,
			error: `session working directory no longer exists: ${session.cwd}`,
		};
	}

	let argv: string[];
	try {
		argv = substituteArgv(entry, params);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const limits = resolveLimits(entry.limits);
	const admission = deps.scheduler.tryAdmit(sessionId, commandLabel, limits);
	if (!admission.ok) {
		return { ok: false, error: admission.reason };
	}

	const invocationId = randomUUID();
	const { seq } = deps.store.insertCommandInvocation({
		sessionId,
		id: invocationId,
		argv,
		stdout: "",
		stderr: "",
		truncated: false,
		label: commandLabel,
	});

	try {
		const result = await executeCommand(argv, session.cwd, limits);
		deps.store.updateCommandInvocationResult({
			seq,
			sessionId,
			id: invocationId,
			stdout: result.stdout,
			stderr: result.stderr,
			truncated: result.truncated,
		});
		if (result.exitOk) {
			return { ok: true, output: result.stdout };
		}
		return {
			ok: false,
			error: result.failureReason ?? "command failed",
			...(result.stdout ? { output: result.stdout } : {}),
		};
	} finally {
		deps.scheduler.release(sessionId);
	}
}

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { checkExecutable } from "../manifest/load";
import type { SessionRegistry } from "../session/registry";
import type { ChatStore } from "../store";
import { describeError } from "../utils/errors";
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
		return { ok: false, error: describeError(error) };
	}

	const staleExecutable = checkExecutable(argv[0]);
	if (staleExecutable) {
		return {
			ok: false,
			error: `command "${commandLabel}" ${staleExecutable}`,
		};
	}

	const limits = resolveLimits(entry.limits);
	const admission = deps.scheduler.tryAdmit(sessionId, commandLabel, limits);
	if (!admission.ok) {
		return { ok: false, error: admission.reason };
	}

	const invocationId = randomUUID();
	try {
		const { seq } = deps.store.insertCommandInvocation({
			sessionId,
			id: invocationId,
			argv,
			stdout: "",
			stderr: "",
			truncated: false,
			label: commandLabel,
		});
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

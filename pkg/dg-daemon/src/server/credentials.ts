import {
	CLI_GRANT_PREFIX_HEADER,
	CLI_GRANT_TOKEN_HEADER,
	CLI_SESSION_ID_HEADER,
	CREDENTIAL_SEALED_PREFIX,
	type CredentialsCliRequest,
	credentialNameInPrefix,
	validateCredentialGrantPrefix,
} from "@dg/common";
import { createScrubber } from "@dg/common/node";
import {
	removeCredentialGrantToken,
	writeCredentialGrantToken,
} from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import type { CredentialStore } from "../store/credentials-store";
import { isExtensionPeer, type SocketState, sendViaQueue } from "./connection";
import { checkExecAllowlist } from "./exec-allowlist";
import type { FrameHandlerDeps } from "./frame-handlers";

type Socket = ServerWebSocket<SocketState>;
export type Result =
	| { ok: true; value: unknown }
	| { ok: false; error: string };
type Access = { scope: "session" } | { scope: "prefix"; prefix: string };

export const EXTENSION_CREDENTIAL_PREFIX = "extension";
export const NOT_ALLOWED = "Credential request not allowed for this caller.";
const SEALED_GET = `Credentials under ${CREDENTIAL_SEALED_PREFIX}/ are never returned; use dg-skills credentials exec to run a command with them.`;
const sealed = (name: string | undefined) => name !== undefined && credentialNameInPrefix(name, CREDENTIAL_SEALED_PREFIX);
const TRANSPORT_ERROR_SESSION_ID = "transport-error";

function socketSessionId(socket: Socket): string | undefined {
	return socket.data.capabilities.keys().next().value;
}

/** Sends the correlated result; the sessionId is the socket's session when it has one. */
export function sendCredentialsResult(
	requester: Socket,
	requestId: string,
	answer: Result,
): Promise<void> {
	return sendViaQueue(
		requester,
		JSON.stringify({
			type: "cli-credentials-result",
			sessionId: socketSessionId(requester) ?? TRANSPORT_ERROR_SESSION_ID,
			requestId,
			...answer,
		}),
	);
}

function resolveAccess(
	requester: Socket,
	frame: CredentialsCliRequest,
	deps: FrameHandlerDeps,
): Access | undefined {
	if (frame.grant)
		return deps.credentials.verifyCredentialGrant(
			frame.grant.prefix,
			frame.grant.token,
		)
			? { scope: "prefix", prefix: validateCredentialGrantPrefix(frame.grant.prefix) }
			: undefined;
	const sessionId = socketSessionId(requester);
	if (!sessionId) return undefined;
	if (requester.data.localPage) return undefined;
	if (isExtensionPeer(requester))
		return { scope: "prefix", prefix: EXTENSION_CREDENTIAL_PREFIX };
	return deps.registry.get(sessionId)?.state === "active"
		? { scope: "session" }
		: undefined;
}

export type ScopedReadInput =
	| { operation: "list" }
	| { operation: "get"; name: string };

/** Reads under one prefix. */
export function scopedRead(
	input: ScopedReadInput,
	prefix: string,
	store: Pick<CredentialStore, "listCredentials" | "getCredential">,
): Result {
	if (input.operation === "list")
		return {
			ok: true,
			value: store
				.listCredentials()
				.filter((entry) => credentialNameInPrefix(entry.name, prefix)),
		};
	if (sealed(input.name)) return { ok: false, error: SEALED_GET };
	if (credentialNameInPrefix(input.name, prefix))
		return { ok: true, value: store.getCredential(input.name) ?? null };
	return { ok: false, error: NOT_ALLOWED };
}

function prefixRead(
	frame: CredentialsCliRequest,
	prefix: string,
	store: Pick<CredentialStore, "listCredentials" | "getCredential">,
): Result {
	if (frame.operation === "list")
		return scopedRead({ operation: "list" }, prefix, store);
	if (frame.operation === "get" && typeof frame.name === "string")
		return scopedRead({ operation: "get", name: frame.name }, prefix, store);
	return { ok: false, error: NOT_ALLOWED };
}

export function hasCredentialGrant(
	req: Request,
	store: Pick<CredentialStore, "verifyCredentialGrant">,
): boolean {
	const prefix = req.headers.get(CLI_GRANT_PREFIX_HEADER);
	const token = req.headers.get(CLI_GRANT_TOKEN_HEADER);
	return (
		prefix !== null &&
		token !== null &&
		!req.headers.has(CLI_SESSION_ID_HEADER) &&
		store.verifyCredentialGrant(prefix, token)
	);
}

function sessionOperation(
	frame: CredentialsCliRequest,
	deps: FrameHandlerDeps,
): unknown {
	const store = deps.credentials;
	switch (frame.operation) {
		case "set":
			store.setCredential(frame.name!, frame.value!, frame.meta);
			return null;
		case "get":
			if (sealed(frame.name)) throw new SealedError();
			return store.getCredential(frame.name!) ?? null;
		case "list":
			return store.listCredentials();
		case "delete":
			return store.deleteCredential(frame.name!);
		case "grant": {
			const prefix = validateCredentialGrantPrefix(frame.prefix!);
			const token = store.createCredentialGrant(prefix);
			return {
				prefix,
				path: writeCredentialGrantToken(deps.paths, prefix, token),
			};
		}
		case "revoke": {
			const prefix = validateCredentialGrantPrefix(frame.prefix!);
			removeCredentialGrantToken(deps.paths, prefix);
			return store.deleteCredentialGrant(prefix);
		}
		case "grant-list":
			return store.listCredentialGrants();
		case "exec":
			throw new Error("exec runs through runExec");
	}
}

class SealedError extends Error {}

const KILL_GRACE_MS = 2000;
const INJECTION_ENV =
	/^(?:LD_|DYLD_|_RLD|MALLOC_|GCONV_PATH$|NODE_OPTIONS$|NODE_PATH$|BUN_|PYTHON|PERL5|PERLLIB$|RUBY|BASH_ENV$|ENV$|ZDOTDIR$|PS4$|SHELLOPTS$|BASHOPTS$|PROMPT_COMMAND$|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|JDK_JAVA_OPTIONS$|CLASSPATH$|GIT_|SSH_ASKPASS$|EDITOR$|VISUAL$|PAGER$|LESSOPEN$|PATH$)/i;

/** The caller's environment without loader and runtime injection variables, with the daemon's own PATH. */
function sealedEnv(env: Record<string, string>): Record<string, string> {
	const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !INJECTION_ENV.test(name)));
	return { ...kept, PATH: process.env.PATH ?? "" };
}

/** Runs a command with stored values in env vars, streams its scrubbed output, and resolves to its exit code; values never leave the daemon. */
async function runExec(requester: Socket, frame: CredentialsCliRequest, deps: FrameHandlerDeps): Promise<Result> {
	const spec = frame.exec!;
	const injected: Record<string, string> = {};
	for (const binding of spec.bindings) {
		const record = deps.credentials.getCredential(binding.name);
		if (!record) return { ok: false, error: `No credential named ${binding.name}.` };
		if (record.value.length < 4)
			return { ok: false, error: `The credential ${binding.name} is shorter than 4 characters, so its output cannot be scrubbed; exec refuses it.` };
		injected[binding.env] = record.value;
	}
	const values = Object.values(injected);
	const sealedNames = spec.bindings.map((binding) => binding.name).filter((name) => sealed(name));
	let argv = spec.argv;
	if (sealedNames.length && spec.bindings.some((binding) => INJECTION_ENV.test(binding.env)))
		return { ok: false, error: "credentials exec with pw/ values refuses to bind a loader, runtime or PATH variable." };
	if (sealedNames.length) {
		const allowed = checkExecAllowlist({
			file: deps.paths.execAllowlistPath,
			command: spec.argv[0] as string,
			cwd: spec.cwd,
			names: sealedNames,
		});
		if (!allowed.ok) return allowed;
		argv = [allowed.path, ...spec.argv.slice(1)];
	}
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(argv, {
			cwd: spec.cwd,
			env: { ...(sealedNames.length ? sealedEnv(spec.env) : spec.env), ...injected },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: process.platform !== "win32",
		});
	} catch {
		return { ok: false, error: `Could not start ${spec.argv[0]}.` };
	}
	const kill = () => {
		const group = (signal: NodeJS.Signals) => {
			try {
				process.kill(-child.pid, signal);
			} catch {}
		};
		if (process.platform === "win32") {
			try {
				Bun.spawn(["taskkill", "/T", "/F", "/PID", String(child.pid)], { stdout: "ignore", stderr: "ignore" });
			} catch {}
			child.kill();
			return;
		}
		group("SIGTERM");
		child.kill();
		setTimeout(() => group("SIGKILL"), KILL_GRACE_MS).unref?.();
	};
	requester.data.closeWaiters.add(kill);
	const pump = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") => {
		const scrubber = createScrubber(values);
		const decoder = new TextDecoder();
		const emit = (data: string) =>
			data
				? sendViaQueue(
						requester,
						JSON.stringify({
							type: "cli-credentials-exec-output",
							sessionId: socketSessionId(requester) ?? TRANSPORT_ERROR_SESSION_ID,
							requestId: frame.requestId,
							stream: name,
							data,
						}),
					)
				: Promise.resolve();
		for await (const chunk of stream) await emit(scrubber.push(decoder.decode(chunk, { stream: true })));
		await emit(scrubber.push(decoder.decode()) + scrubber.flush());
	};
	try {
		await Promise.all([
			pump(child.stdout as ReadableStream<Uint8Array>, "stdout"),
			pump(child.stderr as ReadableStream<Uint8Array>, "stderr"),
		]);
		const code = await child.exited;
		const signal = child.signalCode;
		return { ok: true, value: { exitCode: typeof signal === "string" ? 128 + (signalNumber(signal) ?? 1) : code } };
	} finally {
		requester.data.closeWaiters.delete(kill);
	}
}

function signalNumber(signal: string): number | undefined {
	return ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[signal];
}

/** Serves a session with full access, and a service grant or the extension with get/list under one prefix. */
export async function handleCredentialsRequest(
	requester: Socket,
	frame: CredentialsCliRequest,
	deps: FrameHandlerDeps,
): Promise<void> {
	let answer: Result;
	try {
		const access = resolveAccess(requester, frame, deps);
		if (!access) answer = { ok: false, error: NOT_ALLOWED };
		else if (frame.operation === "exec")
			answer =
				access.scope === "session" && requester.data.kind === "cli"
					? await runExec(requester, frame, deps)
					: { ok: false, error: NOT_ALLOWED };
		else if (access.scope === "prefix")
			answer = prefixRead(frame, access.prefix, deps.credentials);
		else answer = { ok: true, value: sessionOperation(frame, deps) };
	} catch (error) {
		if (error instanceof SealedError) {
			await sendCredentialsResult(requester, frame.requestId, { ok: false, error: SEALED_GET });
			return;
		}
		answer = {
			ok: false,
			error:
				"Credential storage failed; check daemon health and encryption key access.",
		};
	}
	await sendCredentialsResult(requester, frame.requestId, answer);
}

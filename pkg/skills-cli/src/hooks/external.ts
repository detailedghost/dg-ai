import { PluginTransportError, httpTransport, type HttpTransportOptions } from "@dg/common/plugins/transport/http";
import { getIpcConnection, ipcEndpoint } from "@dg/common/plugins/transport/ipc";
import { HOOK_LATENCY_BUDGET_P99_MS, ROUTE_TIMEOUT_MS } from "@dg/common/plugins/contract";
import type { PluginManifest } from "@dg/common/plugins/manifest";
import { askJson } from "./io";
import type { HookResult } from "./types";

export type ExternalHookEvent = { event: string; tool?: string; input?: Record<string, unknown> };

export type ExternalHookOutcome =
	| { decision: "allow" | "deny" | "ask"; reason?: string; latencyMs: number; overBudget: boolean }
	| { failure: "timeout" | "unavailable"; message: string; latencyMs: number };

export type ExternalHookOptions = {
	pluginDir: string;
	allowRemote: boolean;
	timeoutMs?: number;
	credentials?: HttpTransportOptions["credentials"];
	now?: () => number;
};

const ROUTE = "/v1/hook/decide";
const IPC_TIMEOUT_GRACE_MS = 250;
const BUDGET_TRANSPORTS = ["ipc", "http", "tcp"] as const;

type Decision = { decision: "allow" | "deny" | "ask"; reason?: string };

async function decide(manifest: PluginManifest, body: ExternalHookEvent, options: ExternalHookOptions, timeoutMs: number): Promise<Decision> {
	if (manifest.transport === "ipc") {
		const path = ipcEndpoint(manifest.name, options.pluginDir, manifest.endpoint ?? "");
		const connection = await getIpcConnection(manifest.name, path);
		return (await connection.request(ROUTE, body, timeoutMs + IPC_TIMEOUT_GRACE_MS)) as Decision;
	}
	if (manifest.transport === "http") {
		const credentials = options.credentials ?? (await defaultCredentials());
		const response = await httpTransport(manifest, { credentials, allowRemote: options.allowRemote }).request({ route: ROUTE, body }, { timeoutMs });
		return response.body as Decision;
	}
	throw new PluginTransportError("refused", `${manifest.name}: the ${manifest.transport} transport is not supported for hooks. Next: use ipc or http in plugin.toml.`);
}

async function defaultCredentials(): Promise<HttpTransportOptions["credentials"]> {
	const { createCredentialClient, resolveDgPaths } = await import("@dg/common/node");
	return createCredentialClient({ paths: resolveDgPaths() });
}

/** Asks a running hook plugin for a decision; a timeout or an unreachable plugin comes back as a result, never as a throw. */
export async function runExternalHook(manifest: PluginManifest, event: ExternalHookEvent, options: ExternalHookOptions): Promise<ExternalHookOutcome> {
	const { timeoutMs = ROUTE_TIMEOUT_MS[ROUTE], now = () => performance.now() } = options;
	const start = now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new PluginTransportError("timeout", `${manifest.name}: no answer within ${timeoutMs} ms.`)), timeoutMs);
	});
	try {
		const answer = await Promise.race([decide(manifest, event, options, timeoutMs), deadline]);
		const latencyMs = now() - start;
		const budget = HOOK_LATENCY_BUDGET_P99_MS[manifest.transport as (typeof BUDGET_TRANSPORTS)[number]];
		return { decision: answer.decision, ...(answer.reason === undefined ? {} : { reason: answer.reason }), latencyMs, overBudget: latencyMs > budget };
	} catch (error) {
		const latencyMs = now() - start;
		const message = error instanceof Error ? error.message : String(error);
		const timedOut = error instanceof PluginTransportError && error.code === "timeout";
		return { failure: timedOut ? "timeout" : "unavailable", message, latencyMs };
	} finally {
		clearTimeout(timer);
	}
}

export function externalHookResult(name: string, outcome: ExternalHookOutcome, timeoutMs: number): HookResult {
	if ("failure" in outcome) {
		const line =
			outcome.failure === "timeout"
				? `dg hooks: plugin ${name} gave no answer within ${timeoutMs} ms; the tool call goes on.`
				: `dg hooks: plugin ${name} is unavailable, the tool call goes on. ${outcome.message.split("\n")[0]}`;
		return { exitCode: 0, stderr: `${line}\n` };
	}
	if (outcome.decision === "deny") return { exitCode: 2, stderr: `${outcome.reason ?? `plugin ${name} denied the tool call`}\n` };
	if (outcome.decision === "ask") return { exitCode: 0, stdout: askJson(outcome.reason ?? `plugin ${name} asks you to confirm`) };
	return { exitCode: 0 };
}

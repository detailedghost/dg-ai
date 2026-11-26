import { existsSync } from "node:fs";
import { join } from "node:path";
import { privateRootChild, scratchRoot, stateRoot } from "@dg/common/node";
import { applyPatchInputs } from "./adapters/codex-apply-patch";
import { hookSetting } from "./config";
import { additionalContextJson, readStdinJson } from "./io";
import { HOOKS } from "./manifest";
import { runCommand } from "./spawn";
import type { HookContext, HookEnv, HookResult, HookSeams } from "./types";

function spawnDetached(argv: string[]): void {
	const setsid = Bun.which("setsid");
	Bun.spawn(setsid ? [setsid, "-f", ...argv] : argv, {
		stdio: ["ignore", "ignore", "ignore"],
	}).unref();
}

export function defaultSeams(): HookSeams {
	return {
		run: runCommand,
		which: (bin) => Bun.which(bin) ?? undefined,
		spawnDetached,
		stdout: (text) => void process.stdout.write(text),
		stderr: (text) => void process.stderr.write(text),
	};
}

function contextFor(
	env: HookEnv,
	seams: HookSeams,
	sessionId: string,
): HookContext {
	const scratchDir = privateRootChild(
		scratchRoot(env),
		"hooks",
		!!env["AI_SCRATCH_DIR"],
	);
	const warned = new Set<string>();
	const warn = (message: string) => {
		if (warned.has(message)) return;
		warned.add(message);
		seams.stderr(message);
	};
	return {
		env,
		seams,
		sessionId,
		scratchDir,
		stateDir: privateRootChild(stateRoot(env), "hooks", !!env["AI_STATE_DIR"]),
		setting: (hookId, key) => hookSetting(hookId, key, env, warn),
		number: (name, fallback) => {
			const value = Number(env[name]);
			return env[name] && Number.isFinite(value) ? value : fallback;
		},
		bypassed: (name) =>
			[sessionId, markerSession(env)].some((id) =>
				existsSync(join(scratchDir, `${name}.${id}`)),
			),
	};
}

const sanitize = (raw: string) => raw.replace(/[^A-Za-z0-9_-]/g, "_");

/** Session id the hook-comment-disable skill names its marker with: Claude env vars only, else NOSESSION. */
function markerSession(env: HookEnv): string {
	return sanitize(
		env["CLAUDE_CODE_SESSION_ID"] || env["CLAUDE_SESSION_ID"] || "NOSESSION",
	);
}

function sessionOf(env: HookEnv, fromInput: string | undefined): string {
	const raw =
		env["CLAUDE_CODE_SESSION_ID"] ||
		env["CLAUDE_SESSION_ID"] ||
		env["CODEX_THREAD_ID"] ||
		fromInput ||
		"NOSESSION";
	return sanitize(raw);
}

const DEFAULT_EXTERNAL_TIMEOUT_MS = 2_000;

async function runExternal(
	id: string,
	stdin: AsyncIterable<string | Uint8Array>,
	env: HookEnv,
	seams: HookSeams,
): Promise<number> {
	try {
		const { hasConfiguredPlugins, resolveExternalHook } = await import("./plugins");
		const plugin = hasConfiguredPlugins(env) ? await resolveExternalHook(id, env) : undefined;
		if (!plugin) {
			seams.stderr(`hooks run: unknown hook '${id}'\n`);
			return 1;
		}
		const event = await readStdinJson(stdin);
		const requested = Number(env["DG_HOOK_TIMEOUT_MS"]);
		const timeoutMs = requested > 0 && Number.isFinite(requested) ? requested : DEFAULT_EXTERNAL_TIMEOUT_MS;
		const { runExternalHook, externalHookResult } = await import("./external");
		const outcome = await runExternalHook(
			plugin.manifest,
			{
				event: (event as { hook_event_name?: string }).hook_event_name ?? "PreToolUse",
				...(event.tool_name ? { tool: event.tool_name } : {}),
				...(event.tool_input ? { input: event.tool_input } : {}),
			},
			{ pluginDir: plugin.pluginDir, allowRemote: plugin.allowRemote, timeoutMs },
		);
		const result = externalHookResult(id, outcome, timeoutMs);
		if (result.stdout) seams.stdout(result.stdout);
		if (result.stderr) seams.stderr(result.stderr);
		return result.exitCode;
	} catch (error) {
		seams.stderr(
			`hooks run ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	} finally {
		const { closeIpcConnections } = await import(
			"@dg/common/plugins/transport/ipc"
		);
		closeIpcConnections();
	}
}

/** Runs one hook against the stdin event and returns the process exit code. */
export async function runHook(
	id: string,
	stdin: AsyncIterable<string | Uint8Array>,
	env: HookEnv,
	seams: HookSeams = defaultSeams(),
): Promise<number> {
	const def = HOOKS.find((h) => h.id === id);
	if (!def) return runExternal(id, stdin, env, seams);
	if (!def.load) {
		seams.stderr(`hooks run ${id}: runs from git, not from a tool event\n`);
		return 1;
	}
	const event = await readStdinJson(stdin);
	try {
		const ctx = contextFor(env, seams, sessionOf(env, event.session_id));
		const { default: handler } = await def.load();
		const results: HookResult[] = [];
		for (const input of applyPatchInputs(event))
			results.push(await handler(input, ctx));
		const contexts = results.flatMap((r) =>
			r.additionalContext ? [r.additionalContext] : [],
		);
		const stdout = [
			...results.flatMap((r) => (r.stdout ? [r.stdout] : [])),
			...(contexts.length
				? [additionalContextJson(def.event, contexts.join("\n"))]
				: []),
		].join("");
		const stderr = results.map((r) => r.stderr ?? "").join("");
		if (stdout) seams.stdout(stdout);
		if (stderr) seams.stderr(stderr);
		const codes = results.map((r) => r.exitCode);
		return codes.includes(2) ? 2 : Math.max(0, ...codes);
	} catch (error) {
		seams.stderr(
			`hooks run ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}

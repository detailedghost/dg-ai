import { join } from "node:path";

export const CLI_ENTRY = join(import.meta.dir, "../src/index.ts");

export interface CliRun {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Spawn `command` plus `args` with piped output; `stdin` ignored unless given. */
export async function runCli(
	command: readonly string[],
	args: readonly string[],
	options: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<CliRun> {
	const proc = Bun.spawn([...command, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

/**
 * Test-only helpers for exercising env-dependent code (PATH scans,
 * CLAUDE_PLUGIN_ROOT, DG_VERIFY_BROWSER) in a fully controlled environment.
 * Mutating this test process's own `process.env` risks bleeding into sibling
 * spec files sharing the same bun:test process, and Bun.which snapshots PATH
 * at process start rather than reading it live — so PATH-dependent branches
 * need a genuinely fresh process to observe correctly.
 */

/** `process.env` merged with `overrides`, dropping any key overridden to `undefined`. */
export function mergeEnv(
	overrides: Record<string, string | undefined>,
): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [k, v] of Object.entries({ ...process.env, ...overrides })) {
		if (v !== undefined) merged[k] = v;
	}
	return merged;
}

/**
 * Import the zero-arg export `fnName` from `modulePath` in a fresh subprocess
 * under `env` and call it, returning its JSON-serializable result or the
 * stringified thrown error. `process.execPath` (not "bun") is used as the
 * spawned command so an `env` override that strips PATH can't also make the
 * interpreter itself unresolvable.
 */
export async function callInSubprocess(
	modulePath: string,
	fnName: string,
	env: Record<string, string | undefined>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
	const proc = Bun.spawn(
		[
			process.execPath,
			"-e",
			`import { ${fnName} } from ${JSON.stringify(modulePath)};
try {
  console.log(JSON.stringify({ ok: true, value: ${fnName}() }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e) }));
}`,
		],
		{ stdout: "pipe", stderr: "pipe", env: mergeEnv(env) },
	);
	const [out] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	]);
	return JSON.parse(out.trim());
}

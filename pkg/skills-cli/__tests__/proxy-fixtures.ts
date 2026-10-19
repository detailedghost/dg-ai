import {
	chmodSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BuildArgsInput } from "../src/proxy/backends/types";
import { scratchFixtures } from "./git-repo-fixtures";
import { mergeEnv } from "./module-call";

export function makeInput(
	overrides: Partial<BuildArgsInput> = {},
): BuildArgsInput {
	return { prompt: "hello world", ...overrides };
}

export function jsonl(...events: unknown[]): string {
	return events.map((event) => JSON.stringify(event)).join("\n");
}

/** Every fake backend, state record and generated command stays in owned roots. */
export function proxyFixtures() {
	const fixtures = scratchFixtures();
	const root = fixtures.tmp("dg-proxy-' quoted ");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const scratch = join(root, "scratch ' files");
	const state = join(root, "state");
	for (const dir of [home, bin, scratch, state])
		mkdirSync(dir, { recursive: true });
	const sh = Bun.which("sh");
	if (!sh) throw new Error("test requires a POSIX shell");
	symlinkSync(sh, join(bin, "sh"));
	const calls = join(root, "backend-calls.jsonl");
	return {
		...fixtures,
		root,
		home,
		bin,
		scratch,
		state,
		calls,
		env(overrides: Record<string, string | undefined> = {}) {
			return mergeEnv({
				HOME: home,
				XDG_CONFIG_HOME: home,
				AI_SCRATCH_DIR: scratch,
				AI_STATE_DIR: state,
				PATH: bin,
				DG_SKILLS_DIR: undefined,
				DG_SKILLS_DEST: undefined,
				DG_HOME: undefined,
				CLAUDE_PLUGIN_ROOT: undefined,
				CODEX_PLUGIN_ROOT: undefined,
				BG_PROXY_HELPER: undefined,
				DG_PLUGIN_ROOT: undefined,
				DG_PERSONAS_DIR: undefined,
				DG_AGENTS_DIR: undefined,
				FAKE_PROXY_CALLS: calls,
				...overrides,
			});
		},
		fakeBackend(
			name: string,
			options: {
				gate?: string;
				exitCode?: number;
				ignoreTerm?: boolean;
				pidFile?: string;
			} = {},
		) {
			const executable = join(bin, name);
			const events: Record<string, unknown[]> = {
				codex: [
					{ type: "thread.started", thread_id: "fixture-session" },
					{
						type: "item.completed",
						item: { type: "agent_message", text: "fixture done" },
					},
				],
				copilot: [
					{ type: "assistant.message", data: { content: "fixture done" } },
					{ type: "result", sessionId: "fixture-session" },
				],
				pi: [
					{ type: "session", id: "fixture-session" },
					{
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "fixture done" }],
						},
					},
				],
				opencode: [
					{
						type: "text",
						sessionID: "fixture-session",
						part: { text: "fixture done" },
					},
				],
				grok: [
					{ type: "text", sessionId: "fixture-session", data: "fixture done" },
				],
			};
			if (!events[name]) throw new Error(`No fake backend fixture: ${name}`);
			writeFileSync(
				executable,
				`#!${process.execPath}\nimport { appendFileSync, existsSync, writeFileSync } from 'node:fs';\n${options.ignoreTerm ? "process.on('SIGTERM', () => {});" : ""}\n${options.pidFile ? `writeFileSync(${JSON.stringify(options.pidFile)}, String(process.pid));` : ""}\nappendFileSync(process.env.FAKE_PROXY_CALLS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\nconst gate = ${JSON.stringify(options.gate ?? null)};\nwhile (gate && !existsSync(gate)) await Bun.sleep(10);\nfor (const event of ${JSON.stringify(events[name])}) console.log(JSON.stringify(event));\n${options.exitCode ? "console.error('unknown model rejected');" : ""}\nprocess.exit(${options.exitCode ?? 0});\n`,
			);
			chmodSync(executable, 0o755);
			return executable;
		},
		readCalls(): Array<{ args: string[]; cwd: string }> {
			try {
				return readFileSync(calls, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
		},
	};
}

/** Compile once per suite into an owned, relocated root outside the checkout. */
export function compileProxyCli(
	fixture: ReturnType<typeof proxyFixtures>,
): string {
	const binary = join(fixture.root, "moved plugin ' installation", "dg-skills");
	mkdirSync(join(binary, ".."), { recursive: true });
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../build.ts"),
			"--outfile",
			binary,
		],
		{ env: fixture.env(), stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return binary;
}

export async function runProxyProcess(
	argv: string[],
	fixture: ReturnType<typeof proxyFixtures>,
	overrides: Record<string, string | undefined> = {},
) {
	const child = Bun.spawn(argv, {
		cwd: fixture.root,
		env: fixture.env(overrides),
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

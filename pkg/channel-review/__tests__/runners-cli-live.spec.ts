import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runCapture } from "@dg/common/node";
import { loadConfig } from "../src/config";
import { runnerCommand } from "../src/runners";
import { foldGrokStream } from "../src/runners/grok-stream";
import { runProcess } from "../src/runners/spawn";
import { createTempHome, minimalConfigJson, writeConfigFile } from "./support/fakes";

const PROMPT = "Reply with exactly: pong. Do not use tools.";
const LIVE_TIMEOUT_MS = 180_000;

const homes: { cleanup(): void }[] = [];
const dirs: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) home.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harnessConfig() {
	const home = createTempHome();
	homes.push(home);
	return loadConfig(writeConfigFile(home.dir, minimalConfigJson()));
}

function workdir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cli-live-"));
	dirs.push(dir);
	return dir;
}

describe("opt-in Claude Code CLI", () => {
	const enabled = process.env.DG_TEST_CLAUDE_CLI === "1";
	const bin = enabled ? Bun.which("claude") : null;

	test.skipIf(!enabled)("finds claude on PATH when DG_TEST_CLAUDE_CLI=1", () => {
		expect(Bun.which("claude")).not.toBeNull();
	});

	test.skipIf(!enabled || bin === null)(
		"claude auth status succeeds and a one-line prompt returns pong",
		async () => {
			const claude = bin ?? Bun.which("claude");
			if (!claude) throw new Error("claude is not on PATH");
			const login = await runCapture(claude, ["auth", "status"], { timeoutMs: 60_000 });
			expect(login.status, login.stderr || login.stdout).toBe(0);
			const cwd = workdir();
			const config = harnessConfig();
			const argv = runnerCommand(
				"claude",
				claude,
				{
					task: "thrash",
					url: "https://github.com/example/example/pull/1",
					comment: false,
					cwd,
				},
				config,
			);
			const promptAt = argv.indexOf("-p");
			argv[promptAt + 1] = PROMPT;
			expect(argv).toContain("--permission-mode");
			expect(argv).toContain("dontAsk");
			const logPath = join(cwd, "job.log");
			const result = await runProcess({
				argv,
				cwd,
				timeoutMs: LIVE_TIMEOUT_MS,
				logPath,
				keepOauthToken: true,
				signal: new AbortController().signal,
			});
			const log = readFileSync(logPath, "utf8");
			expect(result.timedOut, log).toBe(false);
			expect(result.status, log).toBe(0);
			expect(log.toLowerCase()).toContain("pong");
		},
		LIVE_TIMEOUT_MS + 30_000,
	);
});

describe("opt-in Grok CLI", () => {
	const enabled = process.env.DG_TEST_GROK_CLI === "1";
	const bin = enabled ? Bun.which("grok") : null;

	test.skipIf(!enabled)("finds grok on PATH when DG_TEST_GROK_CLI=1", () => {
		expect(Bun.which("grok")).not.toBeNull();
	});

	test.skipIf(!enabled || bin === null)(
		"grok models succeeds and a one-line prompt returns pong",
		async () => {
			const grok = bin ?? Bun.which("grok");
			if (!grok) throw new Error("grok is not on PATH");
			const login = await runCapture(grok, ["models"], { timeoutMs: 60_000 });
			const loginText = `${login.stderr}\n${login.stdout}`;
			expect(login.status, loginText).toBe(0);
			expect(loginText).not.toMatch(/not authenticated|not signed in/i);
			const cwd = workdir();
			const config = harnessConfig();
			const argv = runnerCommand(
				"grok",
				grok,
				{
					task: "thrash",
					url: "https://github.com/example/example/pull/1",
					comment: false,
					cwd,
				},
				config,
			);
			const promptAt = argv.indexOf("-p");
			argv[promptAt + 1] = PROMPT;
			expect(argv).toContain("--no-auto-update");
			expect(argv).toContain("streaming-json");
			expect(argv).toContain("--always-approve");
			const logPath = join(cwd, "job.log");
			const result = await runProcess({
				argv,
				cwd,
				timeoutMs: LIVE_TIMEOUT_MS,
				logPath,
				signal: new AbortController().signal,
			});
			const log = readFileSync(logPath, "utf8");
			const text = `${log}\n${foldGrokStream(log).text}`.toLowerCase();
			expect(result.timedOut, log).toBe(false);
			expect(result.status, log).toBe(0);
			expect(text).toContain("pong");
		},
		LIVE_TIMEOUT_MS + 30_000,
	);
});

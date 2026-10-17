import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Backend } from "../src/proxy/backends/types";
import { runBackend } from "../src/proxy/spawn";

// ── Test doubles ─────────────────────────────────────────────────────────────

function fakeStream(text: string): ReadableStream {
	return new Response(text).body!;
}

function stubSpawn(opts: { stdout?: string; stderr?: string; exitCode?: number }) {
	const calls: unknown[][] = [];
	const fn = mock((...args: unknown[]) => {
		calls.push(args);
		return {
			stdout: fakeStream(opts.stdout ?? ""),
			stderr: fakeStream(opts.stderr ?? ""),
			exited: Promise.resolve(opts.exitCode ?? 0),
		};
	});
	(Bun as unknown as { spawn: typeof fn }).spawn = fn;
	return { fn, calls };
}

function makeBackend(overrides: Partial<Backend> = {}): Backend {
	return {
		bin: "test-bin",
		buildArgs: mock(() => ["--flag"]),
		parseEvents: mock(() => ({ sessionId: "sess-1", message: "ok" })),
		install: { hint: "install it", command: "brew install test-bin" },
		...overrides,
	};
}

let originalSpawn: typeof Bun.spawn;
let scratchDir: string;
let originalScratchEnv: string | undefined;

beforeEach(() => {
	originalSpawn = Bun.spawn;
	scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-test-"));
	originalScratchEnv = process.env.AI_SCRATCH_DIR;
	process.env.AI_SCRATCH_DIR = scratchDir;
});

afterEach(() => {
	(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
	if (originalScratchEnv === undefined) delete process.env.AI_SCRATCH_DIR;
	else process.env.AI_SCRATCH_DIR = originalScratchEnv;
	fs.rmSync(scratchDir, { recursive: true, force: true });
});

// ── runBackend ───────────────────────────────────────────────────────────────

describe("runBackend", () => {
	test("returns exitCode and parsed session/message from the backend", async () => {
		stubSpawn({ stdout: "line1\n", exitCode: 0 });
		const backend = makeBackend({
			parseEvents: mock(() => ({ sessionId: "abc-123", message: "done" })),
		});

		const result = await runBackend("codex", backend, { prompt: "hi" });

		expect(result.exitCode).toBe(0);
		expect(result.sessionId).toBe("abc-123");
		expect(result.message).toBe("done");
	});

	test("propagates a non-zero exit code", async () => {
		stubSpawn({ exitCode: 7 });
		const backend = makeBackend();

		const result = await runBackend("codex", backend, { prompt: "hi" });

		expect(result.exitCode).toBe(7);
	});

	test("spawns backend.bin combined with buildArgs output", async () => {
		const { calls } = stubSpawn({});
		const backend = makeBackend({
			bin: "my-backend",
			buildArgs: mock(() => ["--model", "x", "--prompt", "hi"]),
		});

		await runBackend("codex", backend, { prompt: "hi" });

		expect(calls[0]?.[0]).toEqual(["my-backend", "--model", "x", "--prompt", "hi"]);
	});

	test("passes buildArgs the full input, including cwd removed from the args call itself", async () => {
		stubSpawn({});
		const buildArgs = mock(() => []);
		const backend = makeBackend({ buildArgs });

		await runBackend("codex", backend, { prompt: "hi", model: "m1", cwd: "/x" });

		// buildArgs receives the raw input object (cwd is consumed separately for spawn options)
		expect(buildArgs).toHaveBeenCalledWith({ prompt: "hi", model: "m1", cwd: "/x" });
	});

	test("uses the provided cwd for the spawned process", async () => {
		const { calls } = stubSpawn({});
		const backend = makeBackend();

		await runBackend("codex", backend, { prompt: "hi", cwd: "/some/dir" });

		expect((calls[0]?.[1] as { cwd?: string }).cwd).toBe("/some/dir");
	});

	test("defaults cwd to process.cwd() when omitted", async () => {
		const { calls } = stubSpawn({});
		const backend = makeBackend();

		await runBackend("codex", backend, { prompt: "hi" });

		expect((calls[0]?.[1] as { cwd?: string }).cwd).toBe(process.cwd());
	});

	test("passes the full stdout text to backend.parseEvents", async () => {
		stubSpawn({ stdout: '{"a":1}\n{"b":2}\n' });
		const parseEvents = mock(() => ({ sessionId: null, message: "" }));
		const backend = makeBackend({ parseEvents });

		await runBackend("codex", backend, { prompt: "hi" });

		expect(parseEvents).toHaveBeenCalledWith('{"a":1}\n{"b":2}\n');
	});

	test("trims whitespace from stderrTail", async () => {
		stubSpawn({ stderr: "  boom\n\n" });
		const backend = makeBackend();

		const result = await runBackend("codex", backend, { prompt: "hi" });

		expect(result.stderrTail).toBe("boom");
	});

	test("truncates stderrTail to the last 2000 characters", async () => {
		const longStderr = "a".repeat(1000) + "b".repeat(2500);
		stubSpawn({ stderr: longStderr });
		const backend = makeBackend();

		const result = await runBackend("codex", backend, { prompt: "hi" });

		expect(result.stderrTail.length).toBe(2000);
		expect(result.stderrTail).toBe("b".repeat(2000));
	});

	test("returns empty stderrTail when stderr is empty", async () => {
		stubSpawn({ stderr: "" });
		const backend = makeBackend();

		const result = await runBackend("codex", backend, { prompt: "hi" });

		expect(result.stderrTail).toBe("");
	});

	test("writes stdout to a logFile under <scratchDir>/proxy", async () => {
		stubSpawn({ stdout: "captured output" });
		const backend = makeBackend();

		const result = await runBackend("mybackend", backend, { prompt: "hi" });

		expect(result.logFile).toContain(`${scratchDir}/proxy/`);
		expect(result.logFile.endsWith("-mybackend.jsonl")).toBe(true);
		expect(fs.readFileSync(result.logFile, "utf8")).toBe("captured output");
	});

	test("creates the proxy scratch directory if it does not already exist", async () => {
		stubSpawn({});
		const backend = makeBackend();

		await runBackend("codex", backend, { prompt: "hi" });

		expect(fs.existsSync(`${scratchDir}/proxy`)).toBe(true);
	});

	test("keeps generated logs inside the explicitly isolated scratch root", async () => {
		stubSpawn({ stdout: "owned log" });
		const result = await runBackend("codex", makeBackend(), { prompt: "hi" });
		expect(path.relative(scratchDir, result.logFile).startsWith("..")).toBe(false);
		expect(fs.readFileSync(result.logFile, "utf8")).toBe("owned log");
	});
});

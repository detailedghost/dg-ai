import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "../src/proxy/backends/types";
import { runBackend } from "../src/proxy/spawn";

function fakeStream(text: string): ReadableStream {
	return new Response(text).body!;
}

function stubSpawn(opts: {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	onSpawn?: () => void;
}) {
	const calls: unknown[][] = [];
	const fn = mock((...args: unknown[]) => {
		calls.push(args);
		opts.onSpawn?.();
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
	scratchDir = mkdtempSync(join(tmpdir(), "spawn-test-"));
	originalScratchEnv = process.env.AI_SCRATCH_DIR;
	process.env.AI_SCRATCH_DIR = scratchDir;
});

afterEach(() => {
	(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
	if (originalScratchEnv === undefined) delete process.env.AI_SCRATCH_DIR;
	else process.env.AI_SCRATCH_DIR = originalScratchEnv;
	rmSync(scratchDir, { recursive: true, force: true });
});


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

		expect(calls[0]?.[0]).toEqual([
			"my-backend",
			"--model",
			"x",
			"--prompt",
			"hi",
		]);
	});

	test("passes buildArgs the raw input, cwd included", async () => {
		stubSpawn({});
		const buildArgs = mock(() => []);
		const backend = makeBackend({ buildArgs });

		await runBackend("codex", backend, {
			prompt: "hi",
			model: "m1",
			cwd: "/x",
		});

		expect(buildArgs).toHaveBeenCalledWith({
			prompt: "hi",
			model: "m1",
			cwd: "/x",
		});
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
		expect(readFileSync(result.logFile, "utf8")).toBe("captured output");
	});

	test("creates the proxy scratch directory if it does not already exist", async () => {
		stubSpawn({});
		const backend = makeBackend();

		await runBackend("codex", backend, { prompt: "hi" });

		expect(existsSync(`${scratchDir}/proxy`)).toBe(true);
	});

	test("creates a private empty transcript before spawning the backend", async () => {
		let transcriptAtSpawn = "";
		stubSpawn({
			stdout: "sensitive backend output",
			onSpawn() {
				const dir = join(scratchDir, "proxy");
				const entries = existsSync(dir) ? readdirSync(dir) : [];
				expect(entries).toHaveLength(1);
				transcriptAtSpawn = join(dir, entries[0]!);
				expect(lstatSync(transcriptAtSpawn).isFile()).toBe(true);
				expect(statSync(transcriptAtSpawn).mode & 0o777).toBe(0o600);
				expect(readFileSync(transcriptAtSpawn, "utf8")).toBe("");
			},
		});

		const result = await runBackend("codex", makeBackend(), { prompt: "hi" });
		expect(result.logFile).toBe(transcriptAtSpawn);
		expect(readFileSync(result.logFile, "utf8")).toBe(
			"sensitive backend output",
		);
	});

	for (const unsafePath of [
		"symlinked tool",
		"writable root ancestor",
	] as const) {
		test(`rejects a ${unsafePath} before spawning the backend`, async () => {
			const outside = join(scratchDir, "outside");
			mkdirSync(outside);
			if (unsafePath === "symlinked tool") {
				symlinkSync(outside, join(scratchDir, "proxy"));
			} else {
				const unsafeParent = join(scratchDir, "shared");
				mkdirSync(unsafeParent, { mode: 0o777 });
				chmodSync(unsafeParent, 0o777);
				process.env.AI_SCRATCH_DIR = join(unsafeParent, "artifacts");
			}
			const { fn } = stubSpawn({ stdout: "must not run" });

			await expect(
				runBackend("codex", makeBackend(), { prompt: "hi" }),
			).rejects.toThrow();
			expect(fn).not.toHaveBeenCalled();
			expect(readdirSync(outside)).toEqual([]);
		});
	}
});

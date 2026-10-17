import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyFixtures } from "./proxy-fixtures";
let fixture: ReturnType<typeof proxyFixtures>;
beforeEach(() => { fixture = proxyFixtures(); });
afterEach(() => fixture.cleanup());
import { BACKENDS } from "../src/proxy/index";

const CLI = `${import.meta.dir}/../src/index.ts`;
const BUN_BIN = process.execPath;

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runCli(args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
	const proc = Bun.spawn([BUN_BIN, "run", CLI, "proxy", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...fixture.env(), ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

// Isolated AI_SCRATCH_DIR per call — runBackend only ever creates <dir>/proxy,
// so its presence is a reliable signal that runBackend actually ran.
function scratchDir(): string {
	return mkdtempSync(join(tmpdir(), "proxy-cli-test-"));
}

function ranRunBackend(scratch: string): boolean {
	return existsSync(join(scratch, "proxy"));
}

// A stand-in backend binary that satisfies checkPreflight (Bun.which finds it
// on PATH) and produces real, parseable pi-backend JSONL if runBackend spawns
// it — never the actual pi CLI.
function fakeBinDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "proxy-cli-fakebin-"));
	const script = join(dir, "pi");
	writeFileSync(script, '#!/bin/sh\necho \'{"type":"session","id":"fake-session-1"}\'\nexit 0\n');
	chmodSync(script, 0o755);
	return dir;
}

const EMPTY_PATH_DIR = "/nonexistent-proxy-cli-test-path";

describe("cli.ts unknown backend", () => {
	test("exits 1 with the expected stderr message and never calls runBackend", async () => {
		const scratch = scratchDir();
		try {
			const { stdout, stderr, exitCode } = await runCli(["not-a-real-backend", "--prompt", "hi"], {
				AI_SCRATCH_DIR: scratch,
			});

			expect(exitCode).toBe(1);
			expect(stderr).toContain(`unknown backend "not-a-real-backend", known: ${Object.keys(BACKENDS).join(", ")}`);
			expect(stdout).toBe("");
			expect(ranRunBackend(scratch)).toBe(false);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("cli.ts --list-backends", () => {
	test("prints exactly the BACKENDS registry keys, one per line, with no other output", async () => {
		const { stdout, stderr, exitCode } = await runCli(["--list-backends"], {});

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toBe(`${Object.keys(BACKENDS).join("\n")}\n`);
	});
});

describe("cli.ts missing backend binary", () => {
	test("checkPreflight failure never reaches runBackend", async () => {
		const scratch = scratchDir();
		try {
			const { stdout, exitCode } = await runCli(["pi", "--prompt", "hi"], {
				PATH: EMPTY_PATH_DIR,
				AI_SCRATCH_DIR: scratch,
			});

			expect(exitCode).toBe(1);
			const parsed = JSON.parse(stdout);
			expect(parsed.bin).toBe("pi");
			expect(parsed.backend).toBe("pi");
			expect(ranRunBackend(scratch)).toBe(false);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("cli.ts persona resolution with --resume", () => {
	test("persona is skipped when --resume is set even if --subagent is also passed", async () => {
		const scratch = scratchDir();
		const fakeBin = fakeBinDir();
		// HOME has no .claude/agents dir at all — if persona resolution ran
		// despite --resume, resolvePersona would throw looking for this file
		// and the process would exit non-zero instead of succeeding.
		const home = mkdtempSync(join(tmpdir(), "proxy-cli-home-"));
		try {
			const { stdout, stderr, exitCode } = await runCli(
				["pi", "--prompt", "hi", "--resume", "some-session", "--subagent", "nonexistent-agent-xyz"],
				{
					PATH: fakeBin,
					HOME: home,
					AI_SCRATCH_DIR: scratch,
				},
			);

			// runBackend always logs its "streaming to logfile" note; the real
			// assertion here is that persona resolution didn't blow up.
			expect(stderr).toContain("proxy: streaming pi output ->");
			expect(exitCode).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.sessionId).toBe("fake-session-1");
			expect(ranRunBackend(scratch)).toBe(true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(fakeBin, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("cli.ts persona resolution failure (no --resume)", () => {
	test("emits a parseable JSON line on stdout in addition to the stderr message", async () => {
		const scratch = scratchDir();
		const fakeBin = fakeBinDir();
		const home = mkdtempSync(join(tmpdir(), "proxy-cli-home-"));
		try {
			const { stdout, stderr, exitCode } = await runCli(
				["pi", "--prompt", "hi", "--subagent", "nonexistent-agent-xyz"],
				{
					PATH: fakeBin,
					HOME: home,
					AI_SCRATCH_DIR: scratch,
				},
			);

			expect(exitCode).toBe(1);
			expect(stderr).toContain("Agent persona not found");
			const parsed = JSON.parse(stdout.trim());
			expect(parsed.exitCode).toBe(1);
			expect(parsed.error).toContain("Agent persona not found");
			expect(ranRunBackend(scratch)).toBe(false);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(fakeBin, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("cli.ts --prompt-file", () => {
	test("reads the prompt from disk and runs normally when --prompt is omitted", async () => {
		const scratch = scratchDir();
		const fakeBin = fakeBinDir();
		const promptFile = join(scratch, "prompt.md");
		writeFileSync(promptFile, "task from file");
		try {
			const { exitCode } = await runCli(["pi", "--prompt-file", promptFile], {
				PATH: fakeBin,
				AI_SCRATCH_DIR: scratch,
			});

			expect(exitCode).toBe(0);
			expect(ranRunBackend(scratch)).toBe(true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(fakeBin, { recursive: true, force: true });
		}
	});

	test("a missing --prompt-file path fails cleanly instead of throwing a raw stack trace", async () => {
		const scratch = scratchDir();
		try {
			const { stdout, stderr, exitCode } = await runCli(["pi", "--prompt-file", "/nonexistent/plan.md"], {
				AI_SCRATCH_DIR: scratch,
			});

			expect(exitCode).toBe(1);
			expect(stderr).toContain("failed to read --prompt-file");
			expect(stdout).toBe("");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("cli.ts --plan / -p", () => {
	test("writes a persona-wrapped plan file, emits the bg launch command, and never spawns the backend", async () => {
		const scratch = scratchDir();
		const fakeBin = fakeBinDir();
		try {
			const { stdout, exitCode } = await runCli(["pi", "--prompt", "do the thing", "--plan"], {
				PATH: fakeBin,
				AI_SCRATCH_DIR: scratch,
			});

			expect(exitCode).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.plan).toBe(true);
			expect(parsed.backend).toBe("pi");
			expect(existsSync(parsed.planFile)).toBe(true);
			expect(readFileSync(parsed.planFile, "utf8")).toBe("do the thing");
			expect(typeof parsed.command).toBe("string");
			expect(parsed.command).toContain("proxy");

			// runBackend never spawned: the proxy dir holds the plan file, never a .jsonl log.
			const files = readdirSync(join(scratch, "proxy"));
			expect(files.some((f) => f.endsWith(".jsonl"))).toBe(false);
			expect(files.some((f) => f.endsWith(".plan.md"))).toBe(true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(fakeBin, { recursive: true, force: true });
		}
	});

	test("-p is an alias for --plan and works even when the backend binary is missing from PATH", async () => {
		const scratch = scratchDir();
		try {
			const { stdout, stderr, exitCode } = await runCli(["pi", "--prompt", "hi", "-p"], {
				PATH: EMPTY_PATH_DIR,
				AI_SCRATCH_DIR: scratch,
			});

			expect(exitCode).toBe(0);
			expect(stderr).toContain("note - pi not found on PATH");
			const parsed = JSON.parse(stdout);
			expect(parsed.plan).toBe(true);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test("propagates --model/--effort/--cwd into the emitted command", async () => {
		const scratch = scratchDir();
		const fakeBin = fakeBinDir();
		try {
			const { stdout } = await runCli(
				["pi", "--prompt", "hi", "--plan", "--model", "m1", "--effort", "high", "--cwd", "/work"],
				{
					PATH: fakeBin,
					AI_SCRATCH_DIR: scratch,
				},
			);

			const parsed = JSON.parse(stdout);
			expect(parsed.command).toContain("m1");
			expect(parsed.command).toContain("high");
			expect(parsed.command).toContain("/work");
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(fakeBin, { recursive: true, force: true });
		}
	});

	test("bad --subagent still fails the plan instead of writing a broken file", async () => {
		const scratch = scratchDir();
		const fakeBin = fakeBinDir();
		const home = mkdtempSync(join(tmpdir(), "proxy-cli-home-"));
		try {
			const { stdout, stderr, exitCode } = await runCli(
				["pi", "--prompt", "hi", "--plan", "--subagent", "nonexistent-agent-xyz"],
				{
					PATH: fakeBin,
					HOME: home,
					AI_SCRATCH_DIR: scratch,
				},
			);

			expect(exitCode).toBe(1);
			expect(stderr).toContain("Agent persona not found");
			const parsed = JSON.parse(stdout.trim());
			expect(parsed.exitCode).toBe(1);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
			rmSync(fakeBin, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("proxy generated launch command", () => {
	test("runs a generated source command with quoted cwd, model and prompt-file paths", async () => {
		fixture.fakePi();
		const cwd = fixture.tmp("dg-proxy-work ' quoted ");
		const prompt = "keep spaces ' quotes and $HOME $(touch forbidden) literally";
		const model = "model ' quoted";
		const planned = await runCli(["pi", "--prompt", prompt, "--plan", "--cwd", cwd, "--model", model, "--effort", "high"], {});
		expect(planned.exitCode).toBe(0);
		const plan = JSON.parse(planned.stdout);
		expect(readFileSync(plan.planFile, "utf8")).toBe(prompt);
		expect(fixture.readCalls()).toEqual([]);
		const child = Bun.spawn(["/bin/sh", "-c", plan.command], { cwd: fixture.root, env: fixture.env(), stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(code, stderr).toBe(0);
		const job = JSON.parse(stdout);
		const deadline = Date.now() + 5000;
		while ((!job.statusFile || !existsSync(job.statusFile)) && Date.now() < deadline) await Bun.sleep(20);
		expect(job.statusFile).toBeDefined();
		expect(readFileSync(job.statusFile, "utf8").trim()).toBe("0");
		expect(fixture.readCalls()).toEqual([{ args: ["--print", prompt, "--mode", "json", "--model", model, "--thinking", "high"], cwd }]);
		const completed = readFileSync(job.logFile, "utf8").trim().split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
		expect(completed.at(-1)).toMatchObject({ sessionId: "fixture-session", message: "fixture done", exitCode: 0 });
		expect(existsSync(join(cwd, "forbidden"))).toBe(false);
	}, 15000);

	test.each([7, 124])("preserves backend status %i and JSON failure details", async exitCode => {
		const dir = fakeBinDir();
		try {
			writeFileSync(join(dir, "pi"), `#!/bin/sh\nprintf '%s\\n' 'unknown model rejected' >&2\nexit ${exitCode}\n`);
			const result = await runCli(["pi", "--prompt", "hi"], { PATH: dir });
			expect(result.exitCode).toBe(exitCode);
			expect(JSON.parse(result.stdout)).toMatchObject({ exitCode, stderrTail: "unknown model rejected", likelyCause: "model" });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKENDS } from "../src/proxy/index";
import { proxyFixtures, runProxyProcess } from "./proxy-fixtures";

const CLI = join(import.meta.dir, "../src/index.ts");

let fixture: ReturnType<typeof proxyFixtures>;
beforeEach(() => {
	fixture = proxyFixtures();
});
afterEach(() => fixture.cleanup());

const runCli = (args: string[], overrides: Record<string, string> = {}) =>
	runProxyProcess(
		[process.execPath, "run", CLI, "proxy", ...args],
		fixture,
		overrides,
	);

const ranRunBackend = () => existsSync(join(fixture.scratch, "proxy"));

async function untilNonEmpty(file: string): Promise<string> {
	const deadline = Date.now() + 5000;
	let text = "";
	while (Date.now() < deadline) {
		text = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
		if (text) break;
		await Bun.sleep(20);
	}
	expect(text, `${file} stayed empty`).not.toBe("");
	return text;
}

describe("cli.ts unknown backend", () => {
	test("exits 1 with the expected stderr message and never calls runBackend", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"not-a-real-backend",
			"--prompt",
			"hi",
		]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain(
			`unknown backend "not-a-real-backend", known: ${Object.keys(BACKENDS).join(", ")}`,
		);
		expect(stdout).toBe("");
		expect(ranRunBackend()).toBe(false);
	});
});

describe("cli.ts --list-backends", () => {
	test("prints exactly the BACKENDS registry keys, one per line, with no other output", async () => {
		const { stdout, stderr, exitCode } = await runCli(["--list-backends"]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toBe(`${Object.keys(BACKENDS).join("\n")}\n`);
	});
});

describe("cli.ts missing backend binary", () => {
	test("checkPreflight failure never reaches runBackend", async () => {
		const { stdout, exitCode } = await runCli(["pi", "--prompt", "hi"]);

		expect(exitCode).toBe(1);
		const parsed = JSON.parse(stdout);
		expect(parsed.bin).toBe("pi");
		expect(parsed.backend).toBe("pi");
		expect(ranRunBackend()).toBe(false);
	});
});

describe("cli.ts persona resolution with --resume", () => {
	test("persona is skipped when --resume is set even if --subagent is also passed", async () => {
		fixture.fakeBackend("pi");

		const { stdout, stderr, exitCode } = await runCli([
			"pi",
			"--prompt",
			"hi",
			"--resume",
			"some-session",
			"--subagent",
			"nonexistent-agent-xyz",
		]);

		expect(stderr).toContain("proxy: streaming pi output ->");
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).sessionId).toBe("fixture-session");
		expect(ranRunBackend()).toBe(true);
	});
});

describe("cli.ts persona resolution failure (no --resume)", () => {
	test("emits a parseable JSON line on stdout in addition to the stderr message", async () => {
		fixture.fakeBackend("pi");

		const { stdout, stderr, exitCode } = await runCli([
			"pi",
			"--prompt",
			"hi",
			"--subagent",
			"nonexistent-agent-xyz",
		]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("Agent persona not found");
		const parsed = JSON.parse(stdout.trim());
		expect(parsed.exitCode).toBe(1);
		expect(parsed.error).toContain("Agent persona not found");
		expect(ranRunBackend()).toBe(false);
	});
});

describe("cli.ts --prompt-file", () => {
	test("reads the prompt from disk and runs normally when --prompt is omitted", async () => {
		fixture.fakeBackend("pi");
		const promptFile = join(fixture.root, "prompt.md");
		writeFileSync(promptFile, "task from file");

		const { exitCode } = await runCli(["pi", "--prompt-file", promptFile]);

		expect(exitCode).toBe(0);
		expect(ranRunBackend()).toBe(true);
	});

	test("a missing --prompt-file path fails cleanly instead of throwing a raw stack trace", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"pi",
			"--prompt-file",
			"/nonexistent/plan.md",
		]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("failed to read --prompt-file");
		expect(stdout).toBe("");
	});
});

describe("cli.ts --plan / -p", () => {
	test("writes a persona-wrapped plan file, emits the bg launch command, and never spawns the backend", async () => {
		fixture.fakeBackend("pi");

		const { stdout, exitCode } = await runCli([
			"pi",
			"--prompt",
			"do the thing",
			"--plan",
		]);

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.plan).toBe(true);
		expect(parsed.backend).toBe("pi");
		expect(readFileSync(parsed.planFile, "utf8")).toBe("do the thing");
		expect(parsed.command).toContain("proxy");
		const files = readdirSync(join(fixture.scratch, "proxy"));
		expect(files.some((f) => f.endsWith(".jsonl"))).toBe(false);
		expect(files.some((f) => f.endsWith(".plan.md"))).toBe(true);
		expect(fixture.readCalls()).toEqual([]);
	});

	test("-p is an alias for --plan and works even when the backend binary is missing from PATH", async () => {
		const { stdout, stderr, exitCode } = await runCli([
			"pi",
			"--prompt",
			"hi",
			"-p",
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toContain("note - pi not found on PATH");
		expect(JSON.parse(stdout).plan).toBe(true);
	});

	test("bad --subagent still fails the plan instead of writing a broken file", async () => {
		fixture.fakeBackend("pi");

		const { stdout, stderr, exitCode } = await runCli([
			"pi",
			"--prompt",
			"hi",
			"--plan",
			"--subagent",
			"nonexistent-agent-xyz",
		]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("Agent persona not found");
		expect(JSON.parse(stdout.trim()).exitCode).toBe(1);
	});
});

describe("proxy generated launch command", () => {
	test("runs a generated source command with quoted cwd, model and prompt-file paths", async () => {
		fixture.fakeBackend("pi");
		const cwd = fixture.tmp("dg-proxy-work ' quoted ");
		const prompt =
			"keep spaces ' quotes and $HOME $(touch forbidden) literally";
		const model = "model ' quoted";
		const planned = await runCli([
			"pi",
			"--prompt",
			prompt,
			"--plan",
			"--cwd",
			cwd,
			"--model",
			model,
			"--effort",
			"high",
		]);
		expect(planned.exitCode).toBe(0);
		const plan = JSON.parse(planned.stdout);
		expect(readFileSync(plan.planFile, "utf8")).toBe(prompt);
		expect(fixture.readCalls()).toEqual([]);
		const launched = await runProxyProcess(
			["/bin/sh", "-c", plan.command],
			fixture,
		);
		expect(launched.exitCode, launched.stderr).toBe(0);
		const job = JSON.parse(launched.stdout);
		expect(await untilNonEmpty(job.statusFile)).toBe("0");
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			try {
				process.kill(job.launcherPid, 0);
			} catch {
				break;
			}
			await Bun.sleep(20);
		}
		expect(fixture.readCalls()).toEqual([
			{
				args: [
					"--print",
					prompt,
					"--mode",
					"json",
					"--model",
					model,
					"--thinking",
					"high",
				],
				cwd,
			},
		]);
		const completed = readFileSync(job.logFile, "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => JSON.parse(line));
		expect(completed.at(-1)).toMatchObject({
			sessionId: "fixture-session",
			message: "fixture done",
			exitCode: 0,
		});
		expect(existsSync(join(cwd, "forbidden"))).toBe(false);
	}, 15000);

	test.each([7, 124])(
		"preserves backend status %i and JSON failure details",
		async (exitCode) => {
			fixture.fakeBackend("pi", { exitCode });
			const result = await runCli(["pi", "--prompt", "hi"]);
			expect(result.exitCode).toBe(exitCode);
			expect(JSON.parse(result.stdout)).toMatchObject({
				exitCode,
				stderrTail: "unknown model rejected",
				likelyCause: "model",
			});
		},
	);
});

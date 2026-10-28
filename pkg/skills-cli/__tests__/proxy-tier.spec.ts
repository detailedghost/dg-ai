import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadTiers, type Tier } from "../src/tiers";
import { proxyFixtures, runProxyProcess } from "./proxy-fixtures";

const CLI = join(import.meta.dir, "../src/index.ts");
const TIERS: Tier[] = ["haiku", "sonnet", "opus"];

let fixture: ReturnType<typeof proxyFixtures>;
beforeEach(() => {
	fixture = proxyFixtures();
});
afterEach(() => fixture.cleanup());

const runCli = (args: string[]) =>
	runProxyProcess([process.execPath, "run", CLI, "proxy", ...args], fixture);

async function argvFor(backend: string, args: string[]): Promise<string[]> {
	fixture.fakeBackend(backend);
	const { exitCode, stderr } = await runCli([backend, "--prompt", "hi", ...args]);
	expect(exitCode, stderr).toBe(0);
	return fixture.readCalls()[0].args;
}

describe("proxy --tier on codex", () => {
	for (const tier of TIERS) {
		test(`passes the ${tier} table effort and no -m when the model is null`, async () => {
			const row = loadTiers().tiers[tier].codex;
			const args = await argvFor("codex", ["--tier", tier]);

			expect(args).toContain(`model_reasoning_effort=${row.effort}`);
			expect(args).not.toContain("-m");
		});
	}

	test("derives the default tier when neither --tier nor --subagent is given", async () => {
		const args = await argvFor("codex", []);

		expect(args).toContain(
			`model_reasoning_effort=${loadTiers().tiers.sonnet.codex.effort}`,
		);
	});

	test("an explicit --effort wins over the table", async () => {
		const args = await argvFor("codex", ["--tier", "haiku", "--effort", "high"]);

		expect(args).toContain("model_reasoning_effort=high");
	});

	test("an explicit --model wins over the table", async () => {
		const args = await argvFor("codex", ["--tier", "opus", "--model", "my-model"]);

		expect(args).toContain("my-model");
		expect(args).toContain(
			`model_reasoning_effort=${loadTiers().tiers.opus.codex.effort}`,
		);
	});
});

describe("proxy --tier on grok", () => {
	for (const tier of TIERS) {
		test(`passes the ${tier} table model and effort`, async () => {
			const row = loadTiers().tiers[tier].grok;
			const args = await argvFor("grok", ["--tier", tier]);

			expect(args).toEqual(
				expect.arrayContaining(["--model", row.model as string]),
			);
			expect(args).toEqual(expect.arrayContaining(["--effort", row.effort]));
		});
	}

	test("an explicit --model wins over the table", async () => {
		const args = await argvFor("grok", ["--tier", "haiku", "--model", "grok-x"]);

		expect(args).toEqual(expect.arrayContaining(["--model", "grok-x"]));
		expect(args).not.toContain(loadTiers().tiers.haiku.grok.model as string);
	});
});

describe("proxy tier from the persona", () => {
	test("--subagent dba with no --tier derives opus", async () => {
		const args = await argvFor("grok", ["--subagent", "dba"]);
		const row = loadTiers().tiers.opus.grok;

		expect(args).toEqual(
			expect.arrayContaining(["--model", row.model as string, "--effort", row.effort]),
		);
	});
});

describe("proxy tier leaves other backends alone", () => {
	test("the copilot argv is unchanged by --tier", async () => {
		const plain = await argvFor("copilot", []);
		fixture.cleanup();
		fixture = proxyFixtures();
		const tiered = await argvFor("copilot", ["--tier", "opus"]);

		expect(tiered).toEqual(plain);
	});
});

describe("proxy fable guard", () => {
	test("--tier fable with --subagent js exits 1 with the resolver message", async () => {
		fixture.fakeBackend("codex");
		const { stdout, stderr, exitCode } = await runCli([
			"codex",
			"--prompt",
			"hi",
			"--tier",
			"fable",
			"--subagent",
			"js",
		]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain('Agent "js" cannot use the fable tier');
		expect(JSON.parse(stdout.trim()).exitCode).toBe(1);
		expect(fixture.readCalls()).toEqual([]);
	});

	test("an unknown --tier value exits 1", async () => {
		fixture.fakeBackend("codex");
		const { stderr, exitCode } = await runCli(["codex", "--prompt", "hi", "--tier", "titan"]);

		expect(exitCode).toBe(1);
		expect(stderr).toContain("--tier");
	});
});

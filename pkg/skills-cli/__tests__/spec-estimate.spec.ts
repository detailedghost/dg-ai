import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type PlanSpec, planText } from "./assign-plan-builder";
import {
	baseEnv,
	disposeSpecContext,
	newSpecContext,
	runSourceSpec,
	type SpecContext,
	type SpecRun,
} from "./spec-fixtures";

const THREE_SLICES: PlanSpec = {
	slices: [
		{ id: 1, primary: "dg:js", complexity: "low", qa: ["dg:qa-code"] },
		{ id: 2, primary: "dg:js", complexity: "high" },
		{ id: 3, primary: "dba", qa: ["security"] },
	],
};

const LINES = {
	balance:
		"balance: 3 slices · 17 agent calls (6 haiku, 9 sonnet, 2 opus, 0 fable) · up to 2 correction rounds",
	cheap:
		"cheap: 3 slices · 17 agent calls (6 haiku, 9 sonnet, 2 opus, 0 fable) · up to 1 correction rounds",
	expensive:
		"expensive: 3 slices · 17 agent calls (6 haiku, 8 sonnet, 3 opus, 0 fable) · up to 2 correction rounds",
};

let context: SpecContext;
beforeEach(() => {
	context = newSpecContext();
});
afterEach(() => disposeSpecContext(context));

function put(name: string, text: string): string {
	const path = join(context.root, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return path;
}

function estimate(args: string[]): Promise<SpecRun> {
	return runSourceSpec(["estimate", ...args], {
		cwd: context.root,
		env: baseEnv(context),
	});
}

describe("dg-skills spec estimate", () => {
	test("prints exactly three lines in the order balance, cheap, expensive", async () => {
		const plan = put("plan.md", planText(THREE_SLICES));
		const run = await estimate([plan]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(
			`${[LINES.balance, LINES.cheap, LINES.expensive].join("\n")}\n`,
		);
	});

	test("--profile cheap prints only the cheap line", async () => {
		const plan = put("plan.md", planText(THREE_SLICES));
		const run = await estimate([plan, "--profile", "cheap"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(`${LINES.cheap}\n`);
	});

	test("counts a proxied slice's yellow call at the primary's resolved tier", async () => {
		const plan = put(
			"plan.md",
			planText({
				slices: [{ id: 1, primary: "dg:js", proxy: "codex", complexity: "high" }],
			}),
		);
		const run = await estimate([plan, "--profile", "expensive"]);
		expect(run.stdout).toBe(
			"expensive: 1 slices · 5 agent calls (2 haiku, 2 sonnet, 1 opus, 0 fable) · up to 2 correction rounds\n",
		);
	});

	test("counts a fable primary's yellow call under fable", async () => {
		const plan = put(
			"plan.md",
			planText({ slices: [{ id: 1, primary: "arch" }] }),
		);
		const run = await estimate([plan, "--profile", "balance"]);
		expect(run.stdout).toBe(
			"balance: 1 slices · 5 agent calls (2 haiku, 2 sonnet, 0 opus, 1 fable) · up to 2 correction rounds\n",
		);
	});

	test("counts each qa reviewer once per slice and not the conditional security reviewer", async () => {
		const plan = put(
			"plan.md",
			planText({ slices: [{ id: 1, primary: "dg:js", qa: ["dg:qa-code", "dg:dba"] }] }),
		);
		const run = await estimate([plan, "--profile", "balance"]);
		expect(run.stdout).toStartWith("balance: 1 slices · 7 agent calls");
	});

	test.each(["codex", "grok"])("--runtime %s prints the full line for every profile", async (runtime) => {
		const plan = put("plan.md", planText(THREE_SLICES));
		const run = await estimate([plan, "--runtime", runtime]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(
			`${[LINES.balance, LINES.cheap, LINES.expensive].join("\n")}\n`,
		);
	});

	test("--profile outside the three exits 2 and names the choices on stderr", async () => {
		const plan = put("plan.md", planText(THREE_SLICES));
		const run = await estimate([plan, "--profile", "turbo"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("--profile must be one of balance, cheap, expensive");
	});

	test("--runtime outside claude, codex and grok exits 2", async () => {
		const plan = put("plan.md", planText(THREE_SLICES));
		const run = await estimate([plan, "--runtime", "gemini"]);
		expect(run.exitCode).toBe(2);
	});

	test("a slice without agents.primary exits 1 with the assign message", async () => {
		const plan = put(
			"plan.md",
			planText({ slices: [{ id: 1, primary: "dg:js" }, { id: 2 }] }),
		);
		const run = await estimate([plan]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("slice 2 has no agents.primary; run /dg:assign");
	});

	test("agents.model outside the tier table exits 1 naming the slice and the value", async () => {
		const plan = put(
			"plan.md",
			planText({ slices: [{ id: 1, primary: "dg:js", model: "gpt" }] }),
		);
		const run = await estimate([plan]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain('slice 1 agents.model "gpt" is not a tier');
	});

	test.each(["-h", "--help"])("%s prints usage and exits 0", async (flag) => {
		const run = await estimate([flag]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("--profile");
		expect(run.stdout).toContain("--runtime");
		expect(run.stderr).toBe("");
	});

	test("a missing plan file exits 2 like the other spec commands", async () => {
		const run = await estimate([join(context.root, "absent.md")]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("file not found");
	});

	test("--profile without a value exits 2", async () => {
		const plan = put("plan.md", planText(THREE_SLICES));
		const run = await estimate([plan, "--profile"]);
		expect(run.exitCode).toBe(2);
	});

	test("--profile overrides execution.profile from the plan", async () => {
		const plan = put("plan.md", planText({ ...THREE_SLICES, profile: "cheap" }));
		const run = await estimate([plan, "--profile", "expensive"]);
		expect(run.stdout).toBe(`${LINES.expensive}\n`);
	});

	test("agents.complexity outside low, medium and high exits 1 naming the slice", async () => {
		const plan = put(
			"plan.md",
			planText({ slices: [{ id: 1, primary: "dg:js", complexity: "extreme" }] }),
		);
		const run = await estimate([plan]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain(
			'slice 1 agents.complexity "extreme" is not one of low, medium, high',
		);
	});

	test("a non-object slice entry exits 1 naming its index", async () => {
		const plan = put("plan.md", "---\nslices:\n  - id: 1\n    agents:\n      primary: dg:js\n  - oops\n---\n");
		const run = await estimate([plan]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("slices[1] is not an object");
	});
});

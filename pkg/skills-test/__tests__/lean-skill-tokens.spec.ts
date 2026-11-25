import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FLOWS,
	checkBudgets,
	descriptionTokens,
	fileTokens,
	measure,
	type Budgets,
} from "../../../scripts/skill-tokens";
import { REPO_ROOT, readRepoFile } from "./test-support";

const FLOW_NAMES = ["spec-plan", "spec-exec", "phone", "stat", "thrash", "verify", "review-loop", "jot"];

function scratch(): string {
	return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "skill-tokens-"));
}

describe("skill token flows", () => {
	test("define exactly the eight flows", () => {
		expect(Object.keys(FLOWS).sort()).toEqual([...FLOW_NAMES].sort());
	});

	test("every flow lists only files that exist", () => {
		const missing = Object.entries(FLOWS).flatMap(([flow, files]) =>
			files.filter((file) => !existsSync(join(REPO_ROOT, file))).map((file) => `${flow}: ${file}`),
		);
		expect(missing).toEqual([]);
	});

	test("every flow starts at a SKILL.md", () => {
		for (const files of Object.values(FLOWS)) expect(files[0]).toMatch(/\/SKILL\.md$/);
	});
});

describe("token counting", () => {
	test("counts bytes divided by four, rounded up", () => {
		const file = join(scratch(), "a.md");
		writeFileSync(file, "x".repeat(9));
		expect(fileTokens(file)).toBe(3);
	});

	test("counts multi-byte characters by bytes", () => {
		const file = join(scratch(), "b.md");
		writeFileSync(file, "é".repeat(4));
		expect(fileTokens(file)).toBe(2);
	});

	test("descriptions count only the frontmatter block of each SKILL.md", () => {
		const root = scratch();
		const a = join(root, "a");
		const b = join(root, "b");
		Bun.spawnSync(["mkdir", "-p", a, b]);
		writeFileSync(join(a, "SKILL.md"), `---\nname: a\n---\n${"body ".repeat(1000)}`);
		writeFileSync(join(b, "SKILL.md"), "---\nname: b\n---\nbody");
		const bytes = "---\nname: a\n---\n".length + "---\nname: b\n---\n".length;
		expect(descriptionTokens([join(a, "SKILL.md"), join(b, "SKILL.md")])).toBe(Math.ceil(bytes / 4));
	});
});

describe("skill-token-budgets.json", () => {
	const budgets = JSON.parse(readRepoFile("scripts", "skill-token-budgets.json")) as Budgets;

	test("has the shape { perFlow, descriptions }", () => {
		expect(Object.keys(budgets).sort()).toEqual(["descriptions", "perFlow"]);
		expect(Object.keys(budgets.perFlow).sort()).toEqual([...FLOW_NAMES].sort());
		for (const value of [budgets.descriptions, ...Object.values(budgets.perFlow)]) {
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});

	test("hold at the current skills", () => {
		expect(checkBudgets(measure(REPO_ROOT), budgets)).toEqual([]);
	});
});

describe("checkBudgets", () => {
	const budgets: Budgets = { perFlow: { jot: 10 }, descriptions: 100 };

	test("passes at the budget", () => {
		expect(checkBudgets({ perFlow: { jot: 10 }, descriptions: 100 }, budgets)).toEqual([]);
	});

	test("reports each overrun", () => {
		const over = checkBudgets({ perFlow: { jot: 11 }, descriptions: 101 }, budgets);
		expect(over).toHaveLength(2);
		expect(over.join("\n")).toContain("jot");
		expect(over.join("\n")).toContain("descriptions");
	});

	test("reports a measured flow that has no budget", () => {
		expect(checkBudgets({ perFlow: { jot: 1, stat: 1 }, descriptions: 1 }, budgets).join("\n")).toContain("stat");
	});
});

describe("skill-tokens.ts command line", () => {
	function run(...args: string[]) {
		const proc = Bun.spawnSync([process.execPath, "scripts/skill-tokens.ts", ...args], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: proc.exitCode, out: proc.stdout.toString() };
	}

	test("prints every flow and the descriptions", () => {
		const { code, out } = run();
		expect(code).toBe(0);
		for (const flow of FLOW_NAMES) expect(out).toContain(flow);
		expect(out).toContain("descriptions");
	});

	test("--gate passes at baseline", () => {
		expect(run("--gate").code).toBe(0);
	});

	test("--gate exits 1 when a budget is overrun", () => {
		const budgets = join(scratch(), "budgets.json");
		writeFileSync(budgets, JSON.stringify({ perFlow: Object.fromEntries(FLOW_NAMES.map((f) => [f, 1])), descriptions: 1 }));
		const { code, out } = run("--gate", "--budgets", budgets);
		expect(code).toBe(1);
		expect(out).toContain("over budget");
	});
});

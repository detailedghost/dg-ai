import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const ENTRY = join(REPO_ROOT, "pkg", "skills-cli", "src", "index.ts");
const SKILLS_DIR = join(REPO_ROOT, "plugins", "dg", "skills");
const CLI_PATH = "~/.dg/bin/dg-skills";
const DOCTOR_LINE = new RegExp(
	`^If a step fails, run ${CLI_PATH.replace(/[~./]/g, "\\$&")} doctor ([a-z][a-z-]*(?: [a-z][a-z-]*)*)\\.?$`,
	"m",
);
const NOT_ITEMS = new Set(["doctor", "help"]);

interface Report {
	items: { item: string; checks: { id: string; status: string }[] }[];
}

const NO_ALLOW_RULE = new Set(["shared"]);

let home = "";
let registered: string[] = [];
let covered = new Map<string, number>();
let allowRuleItems = new Set<string>();
let trees = new Map<string, string[]>();

function parseReport(run: { out: string; err: string }): Report {
	try {
		return JSON.parse(run.out) as Report;
	} catch {
		throw new Error(`doctor --json printed no report; stderr: ${run.err}`);
	}
}

async function runCli(
	args: string[],
): Promise<{ out: string; err: string }> {
	const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, HOME: home, DG_HOME: undefined },
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { out, err };
}

function treeTexts(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return treeTexts(path);
		return /\.(md|mjs)$/.test(entry) ? [readFileSync(path, "utf8")] : [];
	});
}

function doctorLineItems(name: string): string[] | null {
	for (const text of trees.get(name) ?? []) {
		const named = DOCTOR_LINE.exec(text)?.[1];
		if (named) return named.split(" ");
	}
	return null;
}

function skillNames(): string[] {
	return readdirSync(SKILLS_DIR)
		.filter((name) => existsSync(join(SKILLS_DIR, name, "SKILL.md")))
		.sort();
}

function skillsCallingCli(): string[] {
	return skillNames().filter(
		(name) =>
			name !== "doctor" &&
			(trees.get(name) ?? []).some((text) => text.includes(CLI_PATH)),
	);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "doctor-coverage-home-"));
	trees = new Map(
		skillNames().map((name) => [name, treeTexts(join(SKILLS_DIR, name))]),
	);
	const help = await runCli(["--help"]);
	registered = [...help.out.matchAll(/^  ([a-z][a-z-]*)(?: |$)/gm)]
		.map((match) => match[1] ?? "")
		.filter((name) => !NOT_ITEMS.has(name));
	const report = parseReport(await runCli(["doctor", "--json"]));
	covered = new Map(report.items.map((entry) => [entry.item, entry.checks.length]));
	allowRuleItems = new Set(
		report.items
			.filter((entry) => entry.checks.some((check) => check.id === "allow-rule"))
			.map((entry) => entry.item),
	);
}, 120_000);

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("doctor coverage guard", () => {
	test("finds the registered commands and the doctor items", () => {
		expect(registered.length).toBeGreaterThan(20);
		expect(covered.size).toBeGreaterThan(20);
	});

	test("every registered dg-skills command has doctor checks", () => {
		const missing = registered.filter((name) => (covered.get(name) ?? 0) === 0);
		expect(missing).toEqual([]);
	});

	test("every registered dg-skills command checks its allow rule", () => {
		const missing = registered.filter(
			(name) => !NO_ALLOW_RULE.has(name) && !allowRuleItems.has(name),
		);
		expect(missing).toEqual([]);
	});

	test("every packaged skill that calls dg-skills carries the doctor line", () => {
		const missing = skillsCallingCli().filter((name) => doctorLineItems(name) === null);
		expect(missing).toEqual([]);
	});

	test("every doctor line names only items doctor knows", () => {
		for (const name of skillsCallingCli()) {
			for (const item of doctorLineItems(name) ?? [])
				expect([name, item, covered.has(item)]).toEqual([name, item, true]);
		}
	});

	test("the doctor line of each skill names every registered command its tree calls", () => {
		for (const name of skillsCallingCli()) {
			const named = doctorLineItems(name) ?? [];
			const called = new Set(
				(trees.get(name) ?? []).flatMap((text) =>
					[...text.matchAll(/dg-skills ([a-z][a-z-]*)/g)].map((match) => match[1] ?? ""),
				),
			);
			const missing = [...called].filter(
				(sub) => registered.includes(sub) && !named.includes(sub),
			);
			expect([name, missing]).toEqual([name, []]);
		}
	});

	test("instruction-only skills that never call dg-skills get no doctor line", () => {
		const callers = skillsCallingCli();
		const instructionOnly = skillNames().filter(
			(name) => name !== "doctor" && !callers.includes(name),
		);
		expect(instructionOnly.length).toBeGreaterThan(0);
		for (const name of instructionOnly)
			expect([name, doctorLineItems(name)]).toEqual([name, null]);
	});

	test("the doctor skill is packaged", () => {
		expect(existsSync(join(SKILLS_DIR, "doctor", "SKILL.md"))).toBe(true);
	});
});

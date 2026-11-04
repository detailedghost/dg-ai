import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

const SKILL = ["plugins", "dg", "skills", "assign", "SKILL.md"];
const SPEC_MODE = [
	"plugins",
	"dg",
	"skills",
	"assign",
	"references",
	"spec-mode.md",
];
const EDGE_CASES = [
	"plugins",
	"dg",
	"skills",
	"assign",
	"references",
	"edge-cases.md",
];
const MAX_SKILL_LINES = 121;

const RUBRIC_PHRASES = {
	low: "one module and a pattern that already exists in the repo",
	medium: "several files or new behavior with a tested pattern nearby",
	high: "cross-cutting, security-sensitive, ambiguous trade-offs, or no precedent in the repo",
} as const;

function flat(path: string[]): string {
	return readRepoFile(...path).replace(/\s+/g, " ");
}

function lines(path: string[]): string[] {
	return readRepoFile(...path).split("\n");
}

function sentenceWith(text: string, needle: string): string {
	const at = text.indexOf(needle);
	expect(at).toBeGreaterThanOrEqual(0);
	const start = text.lastIndexOf(". ", at) + 1;
	const end = text.indexOf(". ", at);
	return text.slice(start, end === -1 ? undefined : end + 1);
}

describe("assign complexity rubric", () => {
	test("spec-mode.md gives each level one rubric line", () => {
		const rows = lines(SPEC_MODE);
		for (const [level, phrase] of Object.entries(RUBRIC_PHRASES)) {
			const matching = rows.filter(
				(row) => row.includes(`\`${level}\``) && row.includes(phrase),
			);
			expect(matching).toHaveLength(1);
		}
	});

	test("rubric text stays out of SKILL.md", () => {
		const skill = flat(SKILL);
		for (const phrase of Object.values(RUBRIC_PHRASES))
			expect(skill).not.toContain(phrase);
	});

	test("SKILL.md points to spec-mode.md for the rubric under the effort bullet", () => {
		const skill = readRepoFile(...SKILL);
		const effortAt = skill.indexOf("- `effort`");
		const complexityAt = skill.indexOf("- `complexity`");
		expect(effortAt).toBeGreaterThanOrEqual(0);
		expect(complexityAt).toBeGreaterThan(effortAt);
		const bullet = skill.slice(complexityAt, skill.indexOf("\n   - ", complexityAt + 1));
		expect(bullet).toContain("references/spec-mode.md");
		expect(bullet).toMatch(/low\|medium\|high|`low`, `medium`/);
	});

	test("SKILL.md keeps the xhigh with no question sentence", () => {
		expect(flat(SKILL)).toContain("may get `xhigh` with no question");
	});

	test("SKILL.md says assign never writes agents.model", () => {
		expect(flat(SKILL)).toMatch(/never writes `agents\.model`/);
	});

	test("SKILL.md stays within the line budget", () => {
		expect(readRepoFile(...SKILL).trimEnd().split("\n").length).toBeLessThanOrEqual(
			MAX_SKILL_LINES,
		);
	});

	test("tie-break says the highest level wins and any high trigger decides", () => {
		const spec = flat(SPEC_MODE);
		expect(spec).toContain("highest level");
		expect(spec).toContain("highest level wins");
		expect(spec).toMatch(/any `high` trigger decides/);
	});

	test("rating is judged from slice text and files globs, not a repo scan", () => {
		const spec = flat(SPEC_MODE);
		expect(spec).toContain("slice text");
		expect(spec).toContain("`files` globs");
		expect(spec).toMatch(/not a repo scan/);
	});

	test("expensive profile reads complexity and agents.effort still wins", () => {
		const spec = flat(SPEC_MODE);
		expect(spec).toContain("`expensive`");
		expect(spec).toMatch(/`balance` and `cheap` ignore it/);
		expect(spec).toMatch(/`agents\.effort` still wins over the profile/);
	});
});

describe("assign spec-mode complexity write contract", () => {
	test("write block contains complexity with the three levels", () => {
		const spec = readRepoFile(...SPEC_MODE);
		const block = spec.slice(spec.indexOf("```yaml"), spec.indexOf("```", spec.indexOf("```yaml") + 7));
		expect(block).toMatch(/complexity: <low\|medium\|high>/);
	});

	test("output block shows complexity on every example slice", () => {
		const spec = readRepoFile(...SPEC_MODE);
		const output = spec.slice(spec.indexOf("## Output"));
		const count = output.match(/^\s+complexity: (low|medium|high)/gm) ?? [];
		expect(count.length).toBeGreaterThanOrEqual(2);
	});

	test("allowed-keys sentence names complexity and model", () => {
		const spec = flat(SPEC_MODE);
		const sentence = sentenceWith(spec, "No other keys under `agents:`");
		expect(sentence).toContain("`complexity`");
		expect(sentence).toContain("`model`");
		expect(sentence).toMatch(/`model`[^.]*human-set/);
		expect(sentence).toMatch(/never written by `\/dg:assign`/);
	});

	test("dry-run prints complexity in the proposed YAML", () => {
		expect(flat(SPEC_MODE)).toMatch(/--dry-run[^.]*`complexity`/);
	});

	test("report tag order puts complexity before the effort override", () => {
		expect(flat(SPEC_MODE)).toContain(
			"s1 → dba [complexity: high] [effort: xhigh override] (qa: security)",
		);
	});

	test("report line for a backfill slice claims no other change", () => {
		const spec = flat(SPEC_MODE);
		expect(spec).toContain("s2 → js [complexity: medium backfilled]");
		expect(spec).toMatch(/claims no other change/);
	});
});

describe("assign spec-mode backfill gate", () => {
	test("slice with primary and no complexity is backfilled on a plain re-run", () => {
		expect(flat(SPEC_MODE)).toMatch(
			/`primary` set and `complexity` missing is a backfill slice, and a plain re-run backfills it/,
		);
	});

	test("backfill skips the pick and the low-confidence question and writes one key", () => {
		const spec = flat(SPEC_MODE);
		expect(spec).toMatch(/skips steps 3 and 4/);
		expect(spec).toMatch(/never gets an `AskUserQuestion`/);
		expect(spec).toMatch(/writes exactly one new key/);
	});

	test("slice with primary and complexity is skipped unless --force", () => {
		expect(flat(SPEC_MODE)).toMatch(
			/both[^.]*skipped unless `--force`/,
		);
	});

	test("absence-is-steady-state sentence is scoped to effort", () => {
		const spec = flat(SPEC_MODE);
		const sentence = sentenceWith(spec, "absence is the expected steady state");
		expect(sentence).toContain("`effort`");
		expect(sentence).not.toContain("`complexity`");
	});

	test("--force keeps re-picking everything but preserves agents.model", () => {
		const spec = flat(SPEC_MODE);
		expect(spec).toMatch(/`--force`[^.]*re-pick everything/);
		expect(spec).toMatch(/`--force`[^.]*`agents\.model`[^.]*untouched/);
	});
});

describe("assign edge-cases complexity escalation", () => {
	test("escalation section states the four facts without the rubric", () => {
		const edge = flat(EDGE_CASES);
		expect(edge).toMatch(/`high` rating raises nothing by itself/);
		expect(edge).toMatch(/`expensive`[^.]*opus tier at build time/);
		expect(edge).toMatch(/`balance` and `cheap` ignore it/);
		expect(edge).toMatch(/`agents\.effort` still wins/);
		for (const phrase of Object.values(RUBRIC_PHRASES))
			expect(edge).not.toContain(phrase);
	});

	test("complexity facts sit in the Escalation section under four lines", () => {
		const rows = lines(EDGE_CASES);
		const first = rows.findIndex((row) => row.includes("rating raises nothing"));
		expect(first).toBeGreaterThan(5);
		const next = rows.findIndex((row, i) => i > first && row.startsWith("## "));
		expect(next).toBeGreaterThan(first);
		const block = rows.slice(first, next).join("\n").trim();
		expect(block.split("\n").length).toBeLessThan(4);
	});

	test("backfill leaves other agents keys untouched and skips complete bundles", () => {
		const spec = flat(SPEC_MODE);
		expect(spec).toMatch(
			/`primary`, `qa`, `effort` and `proxy` stay untouched/,
		);
		expect(spec).toMatch(/Backfill on a `status: complete` bundle is out of scope/);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	disposeSpecContext,
	executeSpecCase,
	expandPlaceholders,
	expectedTree,
	LEGACY_PROGRAM,
	newSpecContext,
	renameLegacyProgram,
	runSourceSpec,
	type SpecContext,
	type SpecGolden,
	splitFrontmatter,
} from "./spec-fixtures";

const goldens: SpecGolden[] = JSON.parse(
	readFileSync(
		join(import.meta.dir, "fixtures", "spec", "goldens.json"),
		"utf8",
	),
);

let context: SpecContext;
beforeEach(() => {
	context = newSpecContext();
});
afterEach(() => disposeSpecContext(context));

function canonicalFrontmatter(text: string) {
	const { data, body } = splitFrontmatter(expandPlaceholders(text, context));
	return { data, body: body.trimEnd() };
}

function expectTreesMatch(
	golden: SpecGolden,
	actual: Record<string, string>,
): void {
	const expected = expectedTree(golden);
	expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
	for (const [name, text] of Object.entries(expected)) {
		const found = actual[name] ?? "";
		if (golden.semanticFrontmatter && text.startsWith("---\n")) {
			expect(canonicalFrontmatter(found)).toEqual(canonicalFrontmatter(text));
		} else {
			expect(found).toBe(text);
		}
	}
}

describe("dg-skills spec parity with the legacy spec-cli", () => {
	for (const golden of goldens) {
		test(`${golden.args.join(" ").slice(0, 60)} [${golden.id}]`, async () => {
			const outcome = await executeSpecCase(golden, context, runSourceSpec);
			expect(outcome.status).toBe(golden.expect.status);
			expect(outcome.stdout).toBe(golden.expect.stdout);
			expect(outcome.stderr).not.toContain(LEGACY_PROGRAM);
			if (golden.stderrContains) {
				for (const fragment of golden.stderrContains)
					expect(outcome.stderr).toContain(fragment);
			} else {
				expect(outcome.stderr).toBe(renameLegacyProgram(golden.expect.stderr));
			}
			expectTreesMatch(golden, outcome.tree);
		}, 30_000);
	}
});

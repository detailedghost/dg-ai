import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { projectHash } from "@dg/common/node";
import {
	BILLING_VOCABULARY,
	domainRows,
	HELPER_SUBCOMMANDS,
	runMonolith,
	SOFT_CAP_BYTES,
	SOFT_CAP_ROWS,
	type TermRow,
	termRowLine,
	vocabulary,
	writeTree,
} from "./monolith-fixtures";
import {
	disposeSpecContext,
	newSpecContext,
	runFixtureGit,
	type SpecContext,
} from "./spec-fixtures";

const POINTER =
	"- [Vocabulary](monolith.md) -- project-specific terminology; consult before naming things.";

let context: SpecContext;
let live: string;

beforeEach(() => {
	context = newSpecContext();
	live = join(context.root, ".agents", "monolith.md");
});
afterEach(() => disposeSpecContext(context));

function write(rows: TermRow[], extra?: Parameters<typeof vocabulary>[1]) {
	writeTree(context.root, { ".agents/monolith.md": vocabulary(rows, extra) });
}

const helper = (args: string[]) => runMonolith(context, args);

const byteLength = (path: string) =>
	Buffer.byteLength(readFileSync(path, "utf8"));

describe("monolith dispatch", () => {
	test("--help lists every helper subcommand and the generator, exiting 0", async () => {
		const run = await helper(["--help"]);
		expect(run.exitCode).toBe(0);
		for (const name of [...HELPER_SUBCOMMANDS, "worktree-gen"])
			expect(run.stdout).toContain(name);
	});

	test("an unknown subcommand exits 2 and names it", async () => {
		const run = await helper(["bogus"]);
		expect(run.exitCode).toBe(2);
		expect(run.stdout + run.stderr).toContain("bogus");
	});

	test("no subcommand exits 2 with the subcommand list", async () => {
		const run = await helper([]);
		expect(run.exitCode).toBe(2);
		expect(run.stdout + run.stderr).toContain("list-terms");
	});

	test.each([
		"list-terms",
		"list-sections",
		"validate",
		"prune",
		"patch-pointer",
		"cap-report",
		"split",
	])("%s without a file exits 1 asking for FILE", async (name) => {
		const run = await helper([name]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain(`${name}: FILE required`);
	});

	test.each([
		"list-terms",
		"list-sections",
		"validate",
		"prune",
		"patch-pointer",
		"cap-report",
		"split",
	])("%s on a missing file exits 1", async (name) => {
		const run = await helper([name, join(context.root, "absent.md")]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("file not found");
	});
});

describe("monolith bootstrap", () => {
	test("creates .agents and reports a fresh standard layout", async () => {
		const run = await helper(["bootstrap", "."]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(
			`APPEND_MODE=0\nMONOLITH_PATH=${live}\nLIGHT_MODE=0\n`,
		);
		expect(existsSync(join(context.root, ".agents"))).toBe(true);
	});

	test("reports append mode once the live file exists", async () => {
		write(BILLING_VOCABULARY);
		const run = await helper(["bootstrap", context.root]);
		expect(run.stdout).toBe(
			`APPEND_MODE=1\nMONOLITH_PATH=${live}\nLIGHT_MODE=0\n`,
		);
	});

	test("a missing directory exits 1", async () => {
		const run = await helper(["bootstrap", join(context.root, "nodir")]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("directory not found");
	});

	test("an unknown flag exits 1 and suggests --shallow", async () => {
		const run = await helper(["bootstrap", "--bad"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("bootstrap: unknown flag: --bad");
		expect(run.stderr).toContain("--shallow");
	});

	test("--shallow keeps the live file under the state root keyed by the repository", async () => {
		runFixtureGit(["init", "-q", "-b", "main"], context.root);
		const dir = join(
			context.state,
			"monolith",
			projectHash(context.root),
			"work tree",
		);
		const path = join(dir, "monolith.md");
		const first = await helper(["bootstrap", "--shallow"]);
		expect(first.exitCode).toBe(0);
		expect(first.stdout).toBe(
			[
				"APPEND_MODE=0",
				`MONOLITH_PATH=${path}`,
				"LIGHT_MODE=1",
				`LIGHT_DIR=${dir}`,
				`ORIGIN_REPO=${context.root}`,
				"SLUG=work tree",
				"",
			].join("\n"),
		);
		expect(existsSync(join(context.root, ".agents"))).toBe(false);
		writeFileSync(path, "# v\n");
		const second = await helper(["bootstrap", "-s"]);
		expect(second.stdout.split("\n")[0]).toBe("APPEND_MODE=1");
	});

	test("--shallow outside a repository falls back to the anonymous slug", async () => {
		const run = await helper(["bootstrap", "--shallow"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("ORIGIN_REPO=\n");
		expect(run.stdout).toContain("SLUG=anonymous\n");
	});
});

describe("monolith list-terms and list-sections", () => {
	test("list-terms prints every term in the four term sections in order", async () => {
		write(BILLING_VOCABULARY);
		const run = await helper(["list-terms", live]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(
			"Invoice\nLedger\nPayee\nSvc suffix\nOutbox\nSaga\n",
		);
	});

	test("list-terms with a section prints only that section", async () => {
		write(BILLING_VOCABULARY);
		const run = await helper(["list-terms", live, "Concepts"]);
		expect(run.stdout).toBe("Saga\n");
	});

	test("list-terms ignores header rows, separators and non-term sections and unescapes markdown", async () => {
		writeTree(context.root, {
			".agents/monolith.md": [
				"## Domain Terms",
				"| Term | Definition |",
				"|---|---|",
				"| **List\\<T\\>** | generic |",
				"| **snake\\_case** | style |",
				"",
				"## Relationships",
				"| **Ignored** | not a term section |",
				"",
			].join("\n"),
		});
		const run = await helper(["list-terms", live]);
		expect(run.stdout).toBe("List<T>\nsnake_case\n");
	});

	test("list-terms prints nothing for a file without terms", async () => {
		writeTree(context.root, { ".agents/monolith.md": "# empty\n" });
		const run = await helper(["list-terms", live]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe("");
	});

	test("list-sections prints every level-two heading", async () => {
		write(BILLING_VOCABULARY, { trailing: "## Relationships\n" });
		const run = await helper(["list-sections", live]);
		expect(run.stdout).toBe(
			"Domain Terms\nNaming Conventions\nArchitectural Patterns\nConcepts\nRelationships\n",
		);
	});
});

describe("monolith validate", () => {
	test("accepts a file with all four sections and unique terms silently", async () => {
		write(BILLING_VOCABULARY);
		const run = await helper(["validate", live]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout + run.stderr).toBe("");
	});

	test("reports each missing required section and exits 1", async () => {
		writeTree(context.root, {
			".agents/monolith.md": "## Domain Terms\n\n| **A** | a |\n",
		});
		const run = await helper(["validate", live]);
		expect(run.exitCode).toBe(1);
		for (const missing of [
			"Naming Conventions",
			"Architectural Patterns",
			"Concepts",
		])
			expect(run.stderr).toContain(
				`validate: missing required section: ${missing}`,
			);
		expect(run.stderr).not.toContain("section: Domain Terms");
	});

	test("lists a term repeated across sections as a duplicate and exits 1", async () => {
		write([
			{ section: "Domain Terms", term: "Twin" },
			{ section: "Concepts", term: "Twin" },
			{ section: "Concepts", term: "Single" },
		]);
		const run = await helper(["validate", live]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("validate: duplicate term(s) found:\nTwin\n");
		expect(run.stderr).not.toContain("Single");
	});
});

describe("monolith prune", () => {
	const stale = termRowLine(BILLING_VOCABULARY[2] as TermRow);

	function seedSources() {
		writeTree(context.root, {
			"pkg/billing/Invoice.cs": "",
			"pkg/billing/Ledger.cs": "",
			"pkg/billing/Outbox.cs": "",
		});
	}

	test("--dry-run reports rows whose source is gone without editing the file", async () => {
		write(BILLING_VOCABULARY);
		seedSources();
		const before = readFileSync(live, "utf8");
		const run = await helper(["prune", live, "--dry-run"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe("Payee\tgone/missing.cs\n");
		expect(readFileSync(live, "utf8")).toBe(before);
	});

	test("removes only the stale rows and keeps rows without a source", async () => {
		write(BILLING_VOCABULARY);
		seedSources();
		const before = readFileSync(live, "utf8");
		const run = await helper(["prune", live]);
		expect(run.stdout).toBe("Payee\tgone/missing.cs\n");
		expect(readFileSync(live, "utf8")).toBe(before.replace(`${stale}\n`, ""));
	});

	test("resolves relative sources against the project root two levels above the file", async () => {
		write(BILLING_VOCABULARY);
		const run = await helper(["prune", live, "--dry-run"]);
		expect(run.stdout.split("\n").filter(Boolean)).toEqual([
			"Invoice\tpkg/billing/Invoice.cs",
			"Ledger\tpkg/billing/Ledger.cs",
			"Payee\tgone/missing.cs",
			"Outbox\tpkg/billing/Outbox.cs",
		]);
	});

	test("honors an absolute source path", async () => {
		const present = join(context.base, "present.cs");
		writeFileSync(present, "");
		write([
			{ section: "Domain Terms", term: "Here", src: present },
			{
				section: "Domain Terms",
				term: "Gone",
				src: join(context.base, "no.cs"),
			},
		]);
		const run = await helper(["prune", live, "--dry-run"]);
		expect(run.stdout).toBe(`Gone\t${join(context.base, "no.cs")}\n`);
	});

	test("leaves rows outside the term sections alone", async () => {
		write([], { trailing: "## Relationships\n\n| **X** | _src:_ gone.cs |" });
		const run = await helper(["prune", live]);
		expect(run.stdout).toBe("");
		expect(readFileSync(live, "utf8")).toContain("| **X** | _src:_ gone.cs |");
	});
});

describe("monolith patch-pointer", () => {
	async function patched(text: string, verb = "patch-pointer") {
		const file = join(context.root, "AGENTS.md");
		writeFileSync(file, text);
		const run = await helper([verb, file]);
		expect(run.exitCode).toBe(0);
		return readFileSync(file, "utf8");
	}

	test("appends a References section when none exists", async () => {
		expect(await patched("# Agents\n\nBody\n")).toBe(
			`# Agents\n\nBody\n\n## References\n\n${POINTER}\n`,
		);
	});

	test("inserts after a blank line below an existing References heading", async () => {
		expect(await patched("# A\n\n## References\n\n- [x](x.md)\n")).toBe(
			`# A\n\n## References\n\n${POINTER}\n- [x](x.md)\n`,
		);
	});

	test("inserts after the heading and adds a blank when a link follows directly", async () => {
		expect(await patched("## References\n- [x](x.md)\n")).toBe(
			`## References\n- [x](x.md)\n${POINTER}\n\n`,
		);
	});

	test("leaves a file that already links monolith.md untouched", async () => {
		const text = "# A\n\n- [Vocab](monolith.md)\n";
		expect(await patched(text)).toBe(text);
	});

	test("patch-agents-md is an alias with the same result", async () => {
		expect(await patched("# A\n", "patch-agents-md")).toBe(
			`# A\n\n## References\n\n${POINTER}\n`,
		);
	});

	test("a second run changes nothing", async () => {
		const once = await patched("# A\n");
		expect(await patched(once)).toBe(once);
	});
});

describe("monolith cap-report", () => {
	test("reports bytes and per-section rows for a file under both caps", async () => {
		write(BILLING_VOCABULARY);
		const run = await helper(["cap-report", live]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(
			[
				`TOTAL_BYTES=${byteLength(live)}`,
				"SECTION_ROWS_domain_terms=3",
				"SECTION_ROWS_naming_conventions=1",
				"SECTION_ROWS_architectural_patterns=1",
				"SECTION_ROWS_concepts=1",
				"",
			].join("\n"),
		);
	});

	test("exits 1 when a section passes the row cap", async () => {
		write(domainRows("many", SOFT_CAP_ROWS + 1));
		const run = await helper(["cap-report", live]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toContain(
			`SECTION_ROWS_domain_terms=${SOFT_CAP_ROWS + 1}`,
		);
	});

	test("exits 2 when only the byte cap is passed", async () => {
		write(
			Array.from({ length: 6 }, (_, index) => ({
				section: "Domain Terms" as const,
				term: `Fat${index}`,
				definition: "x".repeat(1100),
			})),
		);
		const run = await helper(["cap-report", live]);
		expect(byteLength(live)).toBeGreaterThan(SOFT_CAP_BYTES);
		expect(run.exitCode).toBe(2);
	});

	test("exits 1 rather than 2 when both caps are passed", async () => {
		write(
			Array.from({ length: SOFT_CAP_ROWS + 1 }, (_, index) => ({
				section: "Domain Terms" as const,
				term: `Fat${index}`,
				definition: "x".repeat(200),
			})),
		);
		expect((await helper(["cap-report", live])).exitCode).toBe(1);
	});
});

describe("monolith split", () => {
	const rows: TermRow[] = [
		...domainRows("billing", 3),
		...domainRows("orders", 2),
		...domainRows("orders", 1, "Concepts").map((row) => ({
			...row,
			term: "OrderSaga",
		})),
		{ section: "Naming Conventions", term: "Stray" },
		{ section: "Architectural Patterns", term: "Loose" },
	];
	const dir = () => join(context.root, ".agents", "monolith");

	test("writes one file per domain, folds the rest into general and leaves an index", async () => {
		write(rows);
		const run = await helper(["split", live]);
		expect(run.exitCode).toBe(0);
		expect(readdirSync(dir()).sort()).toEqual([
			"billing.md",
			"general.md",
			"orders.md",
		]);
		expect(run.stdout).toBe(
			[
				`DOMAIN_billing=3:${byteLength(join(dir(), "billing.md"))}`,
				`DOMAIN_orders=3:${byteLength(join(dir(), "orders.md"))}`,
				`DOMAIN_general=2:${byteLength(join(dir(), "general.md"))}`,
				`INDEX_BYTES=${byteLength(live)}`,
				"",
			].join("\n"),
		);
		expect(readFileSync(live, "utf8")).toBe(
			[
				"# Project Vocabulary",
				"<!-- Generated by /monolith. -->",
				"",
				"## Vocabulary by domain",
				"",
				"| Domain | File | Terms |",
				"|--------|------|-------|",
				"| billing | [monolith/billing.md](monolith/billing.md) | 3 |",
				"| orders | [monolith/orders.md](monolith/orders.md) | 3 |",
				"| general | [monolith/general.md](monolith/general.md) | 2 |",
				"",
			].join("\n"),
		);
	});

	test("each domain file carries its rows under their original section", async () => {
		write(rows);
		await helper(["split", live]);
		const orders = readFileSync(join(dir(), "orders.md"), "utf8");
		expect(orders.startsWith("# Project Vocabulary — orders\n")).toBe(true);
		expect(orders).toContain("## Domain Terms");
		expect(orders).toContain("## Concepts");
		expect(orders).toContain(termRowLine(rows[3] as TermRow));
		expect(orders).not.toContain("billingTerm0");
	});

	test("the split layout still lists every term and validates", async () => {
		write(rows);
		await helper(["split", live]);
		const terms = await helper(["list-terms", live]);
		expect(terms.stdout.split("\n").filter(Boolean).sort()).toEqual(
			[
				"Loose",
				"OrderSaga",
				"Stray",
				"billingTerm0",
				"billingTerm1",
				"billingTerm2",
				"ordersTerm0",
				"ordersTerm1",
			].sort(),
		);
		expect((await helper(["validate", live])).exitCode).toBe(0);
	});

	test("cap-report on a split index reports each domain file and judges the widest", async () => {
		write(rows);
		await helper(["split", live]);
		const run = await helper(["cap-report", live]);
		const widest = Math.max(
			...["billing", "orders", "general"].map((name) =>
				byteLength(join(dir(), `${name}.md`)),
			),
		);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain(
			`FILE_BYTES_billing=${byteLength(join(dir(), "billing.md"))}\n`,
		);
		expect(run.stdout).toContain(`TOTAL_BYTES=${widest}\n`);
		expect(run.stdout).toContain("DOMAIN_FILES=3\n");
		expect(run.stdout).toContain("SECTION_ROWS_domain_terms=5\n");
	});

	test("--dry-run prints domain, file, rows and bytes without writing", async () => {
		write(rows);
		const before = readFileSync(live, "utf8");
		const run = await helper(["split", live, "--dry-run"]);
		expect(run.exitCode).toBe(0);
		const lines = run.stdout.trimEnd().split("\n");
		expect(lines.map((line) => line.split("\t").slice(0, 3))).toEqual([
			["billing", join("monolith", "billing.md"), "3"],
			["orders", join("monolith", "orders.md"), "3"],
			["general", join("monolith", "general.md"), "2"],
			["index", "monolith.md", "0"],
		]);
		expect(existsSync(dir())).toBe(false);
		expect(readFileSync(live, "utf8")).toBe(before);
	});

	test("--min-rows above every domain size folds all rows into general and refuses", async () => {
		write(rows);
		const run = await helper(["split", live, "--min-rows", "4"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("every row lands in one domain (general)");
		expect(existsSync(dir())).toBe(false);
	});

	test("--out-dir places the domain files elsewhere and the index links them there", async () => {
		write(rows);
		const out = join(context.root, "docs", "vocab");
		const run = await helper(["split", live, "--out-dir", out]);
		expect(run.exitCode).toBe(0);
		expect(readdirSync(out).sort()).toEqual([
			"billing.md",
			"general.md",
			"orders.md",
		]);
		expect(readFileSync(live, "utf8")).toContain(
			"[vocab/billing.md](vocab/billing.md)",
		);
	});

	test("re-splitting is idempotent and reabsorbs rows whose source moved domains", async () => {
		write(rows);
		await helper(["split", live]);
		const indexOnce = readFileSync(live, "utf8");
		const billingOnce = readFileSync(join(dir(), "billing.md"), "utf8");
		await helper(["split", live]);
		expect(readFileSync(live, "utf8")).toBe(indexOnce);
		expect(readFileSync(join(dir(), "billing.md"), "utf8")).toBe(billingOnce);

		const moved = billingOnce.replace(
			"pkg/billing/File0.ts",
			"pkg/orders/File0.ts",
		);
		writeFileSync(join(dir(), "billing.md"), moved);
		await helper(["split", live]);
		expect(readFileSync(join(dir(), "orders.md"), "utf8")).toContain(
			"billingTerm0",
		);
	});

	test("refuses to split when every row lands in one domain", async () => {
		write(domainRows("only", 5));
		const before = readFileSync(live, "utf8");
		const run = await helper(["split", live]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("every row lands in one domain (only)");
		expect(readFileSync(live, "utf8")).toBe(before);
	});

	test("refuses a file with no term rows", async () => {
		writeTree(context.root, { ".agents/monolith.md": "# empty\n" });
		const run = await helper(["split", live]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("split: no term rows found");
	});

	test.each([["0"], ["x"], ["1.5"]])("--min-rows %s exits 1", async (value) => {
		write(rows);
		const run = await helper(["split", live, "--min-rows", value]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("--min-rows must be a positive integer");
	});

	test("an unknown flag exits 1", async () => {
		write(rows);
		const run = await helper(["split", live, "--wat"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("split: unknown flag: --wat");
	});

	test("exits 2 and names the domains that stay over the byte cap", async () => {
		write([
			...Array.from({ length: 4 }, (_, index) => ({
				section: "Domain Terms" as const,
				term: `Fat${index}`,
				definition: "y".repeat(1700),
				src: `pkg/heavy/F${index}.ts`,
			})),
			...domainRows("light", 3),
		]);
		const run = await helper(["split", live]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain(
			`split: still over the ${SOFT_CAP_BYTES}-byte cap: heavy`,
		);
		expect(byteLength(join(dir(), "heavy.md"))).toBeGreaterThan(SOFT_CAP_BYTES);
		expect(readFileSync(live, "utf8")).toContain("## Vocabulary by domain");
	});
});

describe("monolith conflicts", () => {
	const oldRow = "| **Invoice** | A bill. _src:_ pkg/billing/Invoice.cs |";
	const newRow =
		"| **Invoice** | A request for payment. _src:_ pkg/billing/Invoice.cs |";
	const tsv = (section = "Domain Terms") =>
		`${section}\tInvoice\t${oldRow}\t${newRow}\n`;

	function files(oldRows: string[], newRows: string[]) {
		const wrap = (lines: string[]) =>
			[
				"## Domain Terms",
				"",
				"| Term | Definition |",
				"|--|--|",
				...lines,
				"",
			].join("\n");
		writeTree(context.root, {
			"old.md": wrap(oldRows),
			"new.md": wrap(newRows),
		});
		return [join(context.root, "old.md"), join(context.root, "new.md")];
	}

	test("detect-conflicts prints a TSV line for a term whose row differs", async () => {
		const [a, b] = files(
			[oldRow, "| **Same** | s |"],
			[newRow, "| **Same** | s |", "| **Added** | only new |"],
		);
		const run = await helper(["detect-conflicts", a as string, b as string]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(tsv());
	});

	test("detect-conflicts prints nothing when the files agree", async () => {
		const [a, b] = files([oldRow], [oldRow]);
		const run = await helper(["detect-conflicts", a as string, b as string]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe("");
	});

	test("detect-conflicts requires both files", async () => {
		const first = await helper(["detect-conflicts"]);
		expect(first.exitCode).toBe(1);
		expect(first.stderr).toContain("OLD_FILE required");
		const [a] = files([oldRow], [oldRow]);
		const second = await helper(["detect-conflicts", a as string]);
		expect(second.exitCode).toBe(1);
		expect(second.stderr).toContain("NEW_FILE required");
	});

	function resolution() {
		const [, staging] = files([oldRow], [newRow]);
		const conflicts = join(context.root, "conflicts.tsv");
		const log = join(
			context.root,
			".agents",
			"school",
			"monolith-conflicts.md",
		);
		return { staging: staging as string, conflicts, log };
	}

	test("keeps the existing row in staging and appends the rejected candidate to a new log", async () => {
		const { staging, conflicts, log } = resolution();
		writeFileSync(conflicts, tsv());
		const run = await helper([
			"apply-conflict-resolution",
			staging,
			conflicts,
			log,
		]);
		expect(run.exitCode).toBe(0);
		expect(readFileSync(staging, "utf8")).toContain(oldRow);
		expect(readFileSync(staging, "utf8")).not.toContain(newRow);
		expect(readFileSync(log, "utf8")).toBe(
			[
				"# Monolith Conflicts Log",
				"",
				"<!-- Auto-generated by /monolith in non-interactive mode.",
				"     Each entry preserves the existing row and the rejected new",
				"     candidate so a human can resolve later. -->",
				"",
				"## 2026-01-15 09:30:45",
				"",
				"- **Invoice** (Domain Terms)",
				`  - kept (existing): \`${oldRow}\``,
				`  - rejected (new):  \`${newRow}\``,
				"",
				"",
			].join("\n"),
		);
	});

	test("a second resolution appends another entry under the same header", async () => {
		const { staging, conflicts, log } = resolution();
		writeFileSync(conflicts, tsv());
		await helper(["apply-conflict-resolution", staging, conflicts, log]);
		await helper(["apply-conflict-resolution", staging, conflicts, log]);
		const text = readFileSync(log, "utf8");
		expect(text.match(/# Monolith Conflicts Log/g)).toHaveLength(1);
		expect(text.match(/^## 2026-01-15 09:30:45$/gm)).toHaveLength(2);
	});

	test("an empty conflict list changes nothing and writes no log", async () => {
		const { staging, conflicts, log } = resolution();
		writeFileSync(conflicts, "\n");
		const before = readFileSync(staging, "utf8");
		const run = await helper([
			"apply-conflict-resolution",
			staging,
			conflicts,
			log,
		]);
		expect(run.exitCode).toBe(0);
		expect(readFileSync(staging, "utf8")).toBe(before);
		expect(existsSync(log)).toBe(false);
	});

	test("conflict lines with fewer than four columns are ignored", async () => {
		const { staging, conflicts, log } = resolution();
		writeFileSync(conflicts, "Domain Terms\tInvoice\tonly-three\n");
		const run = await helper([
			"apply-conflict-resolution",
			staging,
			conflicts,
			log,
		]);
		expect(run.exitCode).toBe(0);
		expect(existsSync(log)).toBe(false);
		expect(readFileSync(staging, "utf8")).toContain(newRow);
	});

	test.each([
		[[], "STAGING required"],
		[["s"], "CONFLICTS_TSV required"],
		[["s", "t"], "LOG_PATH required"],
	])("arguments %j exit 1 naming the missing one", async (args, message) => {
		const run = await helper(["apply-conflict-resolution", ...args]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain(message);
	});
});

describe("monolith helper isolation", () => {
	test("runs with no user-local helper, workflow or template on disk or PATH", async () => {
		write(BILLING_VOCABULARY);
		const bare = join(context.base, "bare");
		mkdirSync(bare, { recursive: true });
		const run = await runMonolith(context, ["list-terms", live], {
			env: { PATH: bare, SCRIPTS_ROOT: join(context.base, "no-scripts") },
		});
		expect(run.exitCode).toBe(0);
		expect(run.stdout.split("\n")[0]).toBe("Invoice");
	});
});

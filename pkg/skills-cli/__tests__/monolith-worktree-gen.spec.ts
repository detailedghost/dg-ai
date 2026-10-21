import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cwdHash } from "@dg/common/node";
import {
	BILLING_VOCABULARY,
	domainRows,
	parseGeneratedScan,
	runMonolith,
	SCAN_ASSET,
	TEMPLATE_ASSET,
	vocabulary,
	writeTree,
} from "./monolith-fixtures";
import {
	disposeSpecContext,
	newSpecContext,
	SOURCE_SKILLS,
	type SpecContext,
} from "./spec-fixtures";

const BILLING_TERMS = "Invoice\nLedger\nPayee\nSvc suffix\nOutbox\nSaga";
const EXPLORE = { domain: "Explore", naming: "Explore", concept: "Explore" };

let context: SpecContext;
let worktree: string;

beforeEach(() => {
	context = newSpecContext();
	worktree = context.root;
});
afterEach(() => disposeSpecContext(context));

async function generate(args: string[], out = join(context.base, "scan.mjs")) {
	const run = await runMonolith(context, [
		"worktree-gen",
		worktree,
		"--out",
		out,
		...args,
	]);
	return { run, out };
}

async function generated(args: string[] = []) {
	const { run, out } = await generate(args);
	expect(run.stderr).toBe("");
	expect(run.exitCode).toBe(0);
	const script = readFileSync(out, "utf8");
	return { run, out, script, consts: parseGeneratedScan(script) };
}

describe("monolith worktree-gen full mode", () => {
	test("bakes the live file, its terms, the template and the scan root into the stock workflow", async () => {
		const live = join(worktree, ".agents", "monolith.md");
		const text = vocabulary(BILLING_VOCABULARY);
		writeTree(worktree, { ".agents/monolith.md": text });
		const { run, out, consts } = await generated();

		expect(run.stdout).toBe(`${out}\n`);
		expect(consts).toEqual({
			mode: "full",
			monolithPath: live,
			stagingPath: `${live}.new`,
			existingTerms: BILLING_TERMS,
			existingFileContent: text,
			template: readFileSync(TEMPLATE_ASSET, "utf8"),
			agentTypes: EXPLORE,
			SCAN_ROOT: worktree,
		});
	});

	test("drops the args destructure and defines SCAN_ROOT before the search hierarchy cites it", async () => {
		const { script } = await generated();
		expect(script).not.toContain("} = args || {}");
		expect(script.startsWith("export const meta")).toBe(true);
		expect(script.indexOf("const SCAN_ROOT =")).toBeGreaterThan(-1);
		expect(script.indexOf("const SCAN_ROOT =")).toBeLessThan(
			script.indexOf("SCAN ROOT:"),
		);
	});

	test("inserts the scan root instruction immediately before the search hierarchy heading and keeps the stock prompts verbatim", async () => {
		const { script } = await generated();
		const lines = script.split("\n");
		const anchor = lines.findIndex((line) =>
			line.includes(
				"SEARCH HIERARCHY (use in this order — fall through only on failure):",
			),
		);
		expect(anchor).toBeGreaterThan(0);
		expect(lines[anchor - 1]).toContain(`SCAN ROOT: \${SCAN_ROOT}`);
		const stock = readFileSync(SCAN_ASSET, "utf8");
		const tail = stock.slice(stock.indexOf("const KNOWN ="));
		expect(script).toContain(tail);
	});

	test("an absent live file yields empty terms and content", async () => {
		const { consts } = await generated();
		expect(consts.existingTerms).toBe("");
		expect(consts.existingFileContent).toBe("");
		expect(consts.monolithPath).toBe(join(worktree, ".agents", "monolith.md"));
	});

	test("escapes hostile content through JSON so the script stays one const per line", async () => {
		const hostile = `# T\n\`\${process.exit(1)}\`\n\u2028 "quoted" \\ end\n`;
		writeTree(worktree, { ".agents/monolith.md": hostile });
		const { consts, script } = await generated();
		expect(consts.existingFileContent).toBe(hostile);
		expect(script).not.toContain(hostile);
	});

	test("writes under the scratch root keyed by the worktree when --out is absent", async () => {
		const run = await runMonolith(context, ["worktree-gen", worktree]);
		const expected = join(
			context.scratch,
			"monolith",
			cwdHash(worktree),
			"scan.worktree.mjs",
		);
		expect(run.stderr).toBe("");
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(`${expected}\n`);
		expect(parseGeneratedScan(readFileSync(expected, "utf8")).SCAN_ROOT).toBe(
			worktree,
		);
	});
});

describe("monolith worktree-gen shallow and staging paths", () => {
	test("shallow mode targets the live file and staging path given on the command line", async () => {
		const live = join(context.state, "monolith", "slug", "monolith.md");
		const staging = join(context.state, "monolith", "slug", "staged.md");
		const { consts } = await generated([
			"--mode",
			"shallow",
			"--monolith-path",
			live,
			"--staging-path",
			staging,
		]);
		expect(consts.mode).toBe("shallow");
		expect(consts.monolithPath).toBe(live);
		expect(consts.stagingPath).toBe(staging);
		expect(consts.existingFileContent).toBe("");
		expect(consts.existingTerms).toBe("");
	});

	test("shallow mode reads existing content and terms from the live file outside the worktree", async () => {
		const live = join(context.state, "live", "monolith.md");
		const text = vocabulary(BILLING_VOCABULARY);
		writeTree(context.state, { "live/monolith.md": text });
		const { consts } = await generated([
			"--mode",
			"shallow",
			"--monolith-path",
			live,
		]);
		expect(consts.existingFileContent).toBe(text);
		expect(consts.existingTerms).toBe(BILLING_TERMS);
	});

	test("staging defaults to the monolith path plus .new", async () => {
		const live = join(context.state, "custom.md");
		const { consts } = await generated(["--monolith-path", live]);
		expect(consts.mode).toBe("full");
		expect(consts.stagingPath).toBe(`${live}.new`);
	});

	test("an explicit staging path wins over the default", async () => {
		const staging = join(context.state, "elsewhere.md");
		const { consts } = await generated(["--staging-path", staging]);
		expect(consts.stagingPath).toBe(staging);
		expect(consts.monolithPath).toBe(join(worktree, ".agents", "monolith.md"));
	});
});

describe("monolith worktree-gen existing terms", () => {
	test("a terms file replaces the terms read from the live file and loses trailing newlines", async () => {
		writeTree(worktree, {
			".agents/monolith.md": vocabulary(BILLING_VOCABULARY),
		});
		const termsFile = join(context.base, "terms.txt");
		writeFileSync(termsFile, "Alpha\nBeta\n\n\n");
		const { consts } = await generated(["--terms-file", termsFile]);
		expect(consts.existingTerms).toBe("Alpha\nBeta");
		expect(consts.existingFileContent).toBe(vocabulary(BILLING_VOCABULARY));
	});

	test("a terms file works when no live file exists", async () => {
		const termsFile = join(context.base, "terms.txt");
		writeFileSync(termsFile, "Solo\n");
		const { consts } = await generated(["--terms-file", termsFile]);
		expect(consts.existingTerms).toBe("Solo");
	});

	test("a split live file contributes the terms of every domain file it indexes", async () => {
		const billing = domainRows("billing", 3);
		const orders = domainRows("orders", 3);
		writeTree(worktree, {
			".agents/monolith.md": [
				"# Project Vocabulary",
				"",
				"## Vocabulary by domain",
				"",
				"| Domain | File | Terms |",
				"|--------|------|-------|",
				"| billing | [monolith/billing.md](monolith/billing.md) | 3 |",
				"| orders | [monolith/orders.md](monolith/orders.md) | 3 |",
				"",
			].join("\n"),
			".agents/monolith/billing.md": vocabulary(billing),
			".agents/monolith/orders.md": vocabulary(orders),
		});
		const { consts } = await generated();
		expect(consts.existingTerms.split("\n")).toEqual([
			...billing.map((row) => row.term),
			...orders.map((row) => row.term),
		]);
	});

	test("a missing terms file exits 1 naming the file", async () => {
		const missing = join(context.base, "absent.txt");
		const { run } = await generate(["--terms-file", missing]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain(`terms file not found: ${missing}`);
		expect(run.stdout).toBe("");
	});
});

describe("monolith worktree-gen agent routing", () => {
	const routed: Array<[string, Record<string, string>, string]> = [
		["a solution file", { "App.sln": "" }, "dg:csharp"],
		["a slnx file", { "App.slnx": "" }, "dg:csharp"],
		["a csproj at the root", { "App.csproj": "" }, "dg:csharp"],
		[
			"a csproj under src two levels down",
			{ "src/Api/Api.csproj": "" },
			"dg:csharp",
		],
		["a csproj under pkg", { "pkg/Api.csproj": "" }, "dg:csharp"],
		["a tsconfig", { "tsconfig.json": "{}" }, "dg:js"],
		["a package.json", { "package.json": "{}" }, "dg:js"],
		["a pyproject", { "pyproject.toml": "" }, "dg:python"],
		["a setup.py", { "setup.py": "" }, "dg:python"],
		["a requirements file", { "requirements.txt": "" }, "dg:python"],
		["a go module", { "go.mod": "" }, "general-purpose"],
		["a Cargo manifest", { "Cargo.toml": "" }, "general-purpose"],
		["a pom", { "pom.xml": "" }, "general-purpose"],
		["a gradle build", { "build.gradle": "" }, "general-purpose"],
		["a kotlin gradle build", { "build.gradle.kts": "" }, "general-purpose"],
		["a Gemfile", { Gemfile: "" }, "general-purpose"],
	];

	test.each(routed)(
		"%s routes domain and concept scanners to %s while naming stays Explore",
		async (_label, files, agent) => {
			writeTree(worktree, files);
			const { consts } = await generated();
			expect(consts.agentTypes).toEqual({
				domain: agent,
				naming: "Explore",
				concept: agent,
			});
		},
	);

	test("two stacks together fall back to Explore for every scanner", async () => {
		writeTree(worktree, { "package.json": "{}", "go.mod": "" });
		expect((await generated()).consts.agentTypes).toEqual(EXPLORE);
	});

	test("a tree with no recognised marker falls back to Explore", async () => {
		writeTree(worktree, { "README.md": "" });
		expect((await generated()).consts.agentTypes).toEqual(EXPLORE);
	});

	test("a csproj three directories below the root is not seen", async () => {
		writeTree(worktree, { "a/b/c/Deep.csproj": "" });
		expect((await generated()).consts.agentTypes).toEqual(EXPLORE);
	});
});

describe("monolith worktree-gen status and errors", () => {
	test("--help prints usage and exits 0 without needing a worktree", async () => {
		const run = await runMonolith(context, ["worktree-gen", "--help"]);
		expect(run.exitCode).toBe(0);
		for (const flag of [
			"--mode",
			"--monolith-path",
			"--staging-path",
			"--terms-file",
			"--out",
		])
			expect(run.stdout).toContain(flag);
	});

	const failures: Array<[string, (worktree: string) => string[], string]> = [
		["no worktree path", () => [], "<worktree-path> is required"],
		[
			"a relative worktree path",
			() => ["relative/dir"],
			"worktree-path must be absolute",
		],
		[
			"a worktree path that does not exist",
			(root) => [`${root}/nope`],
			"worktree path not found",
		],
		[
			"an unknown mode",
			(root) => [root, "--mode", "deep"],
			"--mode must be 'full' or 'shallow', got: deep",
		],
		[
			"a dangling --mode",
			(root) => [root, "--mode"],
			"--mode requires a value",
		],
		["a dangling --out", (root) => [root, "--out"], "--out requires a value"],
		[
			"an unknown option",
			(root) => [root, "--bogus"],
			"unknown option: --bogus",
		],
	];

	test.each(failures)(
		"%s exits 1 with an error on stderr and nothing on stdout",
		async (_label, build, message) => {
			const run = await runMonolith(context, [
				"worktree-gen",
				...build(worktree),
			]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain(`error: ${message}`);
			expect(run.stdout).toBe("");
		},
	);

	test("an installed skill without the scan workflow exits 1 naming DG_SKILLS_DIR", async () => {
		const empty = join(context.base, "empty skills");
		mkdirSync(empty, { recursive: true });
		const run = await runMonolith(context, ["worktree-gen", worktree], {
			env: { DG_SKILLS_DIR: empty },
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("DG_SKILLS_DIR");
		expect(run.stderr).not.toContain("$bunfs");
		expect(run.stdout).toBe("");
	});

	test("a scan workflow without the search hierarchy anchor exits 1", async () => {
		const skills = join(context.base, "drifted skills");
		cpSync(join(SOURCE_SKILLS, "monolith"), join(skills, "monolith"), {
			recursive: true,
		});
		const scan = join(skills, "monolith", "references", "scan.workflow.mjs");
		writeFileSync(
			scan,
			readFileSync(scan, "utf8").replace(
				"SEARCH HIERARCHY (use",
				"HIERARCHY (use",
			),
		);
		const run = await runMonolith(context, ["worktree-gen", worktree], {
			env: { DG_SKILLS_DIR: skills },
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("SEARCH_HIERARCHY anchor not found");
		expect(run.stdout).toBe("");
	});

	test("a scan workflow whose args destructure cannot be stripped exits 1 and leaves no script", async () => {
		const skills = join(context.base, "drifted destructure");
		cpSync(join(SOURCE_SKILLS, "monolith"), join(skills, "monolith"), {
			recursive: true,
		});
		const scan = join(skills, "monolith", "references", "scan.workflow.mjs");
		writeFileSync(
			scan,
			readFileSync(scan, "utf8").replace(
				/\nconst \{\n[\s\S]*?\n\} = args \|\| \{\}\n/,
				"\nconst { mode } = args || {}\n",
			),
		);
		const out = join(context.base, "bad-scan.mjs");
		const run = await runMonolith(
			context,
			["worktree-gen", worktree, "--out", out],
			{ env: { DG_SKILLS_DIR: skills } },
		);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("generated script may be malformed");
		expect(run.stdout).toBe("");
		expect(existsSync(out)).toBe(false);
	});

	test.skipIf(process.getuid?.() === 0)(
		"an unreadable domain file warns on stderr and still generates",
		async () => {
			const domain = join(worktree, ".agents", "monolith", "billing.md");
			writeTree(worktree, {
				".agents/monolith/billing.md": vocabulary(BILLING_VOCABULARY),
				".agents/monolith.md": [
					"# Project Vocabulary",
					"",
					"## Vocabulary by domain",
					"",
					"| Domain | File | Terms |",
					"|--------|------|-------|",
					"| billing | [monolith/billing.md](monolith/billing.md) | 6 |",
					"",
				].join("\n"),
			});
			chmodSync(domain, 0o000);
			const { run, out } = await generate([]);
			chmodSync(domain, 0o644);
			expect(run.exitCode).toBe(0);
			expect(run.stderr).toContain("warn:");
			expect(run.stderr).toContain(".agents/monolith.md");
			expect(parseGeneratedScan(readFileSync(out, "utf8")).existingTerms).toBe("");
		},
	);

	test("generation never reads user-local workflow, template or helper files", async () => {
		const decoy = join(context.base, "decoy home");
		writeTree(decoy, {
			".claude/skills/monolith/references/scan.workflow.mjs": "decoy",
			".claude/skills/monolith/references/template.md": "decoy",
		});
		const run = await runMonolith(context, ["worktree-gen", worktree], {
			env: { HOME: decoy, SCRIPTS_ROOT: join(decoy, "scripts") },
		});
		expect(run.exitCode).toBe(0);
		const script = readFileSync(run.stdout.trim(), "utf8");
		expect(script).not.toContain("decoy");
	});
});

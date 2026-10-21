import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scratchDir } from "@dg/common/node";
import { die, EXIT } from "../utils/legacy-command";
import { resolveSkillAsset } from "../utils/skill-assets";
import { listVocabularyTerms } from "./helper";

const LANG_AGENT_MAP: Record<string, string> = {
	csharp: "dg:csharp",
	dotnet: "dg:csharp",
	typescript: "dg:js",
	javascript: "dg:js",
	python: "dg:python",
	go: "general-purpose",
	rust: "general-purpose",
	java: "general-purpose",
	kotlin: "general-purpose",
	ruby: "general-purpose",
};

const LANG_MARKERS: Array<[string[], string]> = [
	[["*.sln", "*.slnx", "*.csproj"], "csharp"],
	[["tsconfig.json", "package.json"], "typescript"],
	[["pyproject.toml", "setup.py", "requirements.txt"], "python"],
	[["go.mod"], "go"],
	[["Cargo.toml"], "rust"],
	[["pom.xml", "build.gradle", "build.gradle.kts"], "java"],
	[["Gemfile"], "ruby"],
];

const SEARCH_ANCHOR =
	"SEARCH HIERARCHY (use in this order — fall through only on failure):";

const SCAN_ROOT_LINE =
	"  `SCAN ROOT: $" +
	"{SCAN_ROOT} — run ALL file searches under this absolute path; emit every _src:_ path RELATIVE to it (strip the SCAN_ROOT/ prefix).`,";

const REQUIRED_CONSTS = [
	"const mode =",
	"const monolithPath =",
	"const stagingPath =",
	"const existingTerms =",
	"const existingFileContent =",
	"const template =",
	"const agentTypes =",
	"const SCAN_ROOT =",
	"SCAN ROOT:",
];

function usage(): string {
	return `monolith worktree-gen — emit a worktree-scoped scan.workflow.mjs for /monolith

Usage:
  dg-skills monolith worktree-gen <worktree-path> [options]

Arguments:
  <worktree-path>     Absolute path to the git worktree to scan.

Options:
  --mode MODE         'full' (default; 3 scanners) or 'shallow' (1 scanner).
  --monolith-path F   Live monolith.md path to read/merge and target. Defaults
                      to <worktree-path>/.agents/monolith.md. Use with --mode shallow,
                      where the live file lives under the state root.
  --staging-path F    Where lore writes the updated file. Defaults to
                      <monolith-path>.new.
  --terms-file FILE   Read existing terms from FILE (one per line).
                      Defaults to the terms of the resolved monolith path if it
                      exists.
  --out FILE          Write generated script to FILE instead of the default
                      <scratch-root>/monolith/<worktree-hash>/scan.worktree.mjs
  --help, -h          Show this message.

Output:
  One line: the absolute path to the generated workflow script.
  Pass it to Workflow({ scriptPath }) — do not run it with node/bun directly.

Exit codes:
  0  success
  1  error`;
}

function hasMarker(base: string, pattern: string): boolean {
	for (const glob of [pattern, `*/${pattern}`]) {
		const matches = new Bun.Glob(glob).scanSync({
			cwd: base,
			onlyFiles: true,
			dot: true,
		});
		if (!matches.next().done) return true;
	}
	return false;
}

function detectLang(worktreePath: string): string | null {
	const found = new Set<string>();
	for (const [patterns, lang] of LANG_MARKERS) {
		for (const pattern of patterns) {
			if (!pattern.startsWith("*")) {
				if (existsSync(path.join(worktreePath, pattern))) found.add(lang);
				continue;
			}
			for (const dir of [".", "pkg", "src", "lib"]) {
				const base = path.join(worktreePath, dir);
				if (existsSync(base) && hasMarker(base, pattern)) found.add(lang);
			}
		}
	}
	if (found.size !== 1) return null;
	return [...found][0] ?? null;
}

function readExistingTerms(monolithPath: string): string {
	try {
		if (!statSync(monolithPath).isFile()) return "";
		return listVocabularyTerms(monolithPath).join("\n").trimEnd();
	} catch (error) {
		process.stderr.write(
			`warn: could not read existing terms from ${monolithPath}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return "";
	}
}

function skillAsset(relative: string): string {
	try {
		return resolveSkillAsset("monolith", relative);
	} catch (error) {
		return die(error instanceof Error ? error.message : String(error));
	}
}

interface Options {
	worktreePath: string;
	termsFile: string | null;
	outFile: string | null;
	mode: string;
	monolithPath: string | null;
	stagingPath: string | null;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		worktreePath: "",
		termsFile: null,
		outFile: null,
		mode: "full",
		monolithPath: null,
		stagingPath: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--mode") {
			options.mode = argv[++i] ?? die("--mode requires a value");
		} else if (arg === "--monolith-path") {
			options.monolithPath =
				argv[++i] ?? die("--monolith-path requires a value");
		} else if (arg === "--staging-path") {
			options.stagingPath = argv[++i] ?? die("--staging-path requires a value");
		} else if (arg === "--terms-file") {
			options.termsFile = argv[++i] ?? die("--terms-file requires a value");
		} else if (arg === "--out") {
			options.outFile = argv[++i] ?? die("--out requires a value");
		} else if (!arg.startsWith("-")) {
			options.worktreePath = arg;
		} else {
			die(`unknown option: ${arg}\n\n${usage()}`);
		}
	}
	return options;
}

/** Generate the scan workflow; returns the exit status. */
export function worktreeGen(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${usage()}\n`);
		return EXIT.OK;
	}

	const { worktreePath, termsFile, outFile, mode, ...paths } = parseArgs(argv);
	if (mode !== "full" && mode !== "shallow")
		die(`--mode must be 'full' or 'shallow', got: ${mode}`);
	if (!worktreePath) die(`<worktree-path> is required\n\n${usage()}`);
	if (!path.isAbsolute(worktreePath)) die("worktree-path must be absolute");
	if (!existsSync(worktreePath))
		die(`worktree path not found: ${worktreePath}`);

	const scanSource = skillAsset("references/scan.workflow.mjs");
	const templateSource = skillAsset("references/template.md");

	const monolithPath =
		paths.monolithPath ?? path.join(worktreePath, ".agents", "monolith.md");
	const stagingPath = paths.stagingPath ?? `${monolithPath}.new`;
	const hasExisting = existsSync(monolithPath);
	const existingFileContent = hasExisting
		? readFileSync(monolithPath, "utf8")
		: "";

	let existingTerms = "";
	if (termsFile) {
		if (!existsSync(termsFile)) die(`terms file not found: ${termsFile}`);
		existingTerms = readFileSync(termsFile, "utf8").trimEnd();
	} else if (hasExisting) {
		existingTerms = readExistingTerms(monolithPath);
	}

	const lang = detectLang(worktreePath);
	const agentForLang = lang ? (LANG_AGENT_MAP[lang] ?? "Explore") : "Explore";
	const agentTypes = {
		domain: agentForLang,
		naming: "Explore",
		concept: agentForLang,
	};

	let body = readFileSync(scanSource, "utf8");
	body = body.replace(/\nconst \{\n[\s\S]*?\n\} = args \|\| \{\}\n/, "\n");

	const anchorLine = `  '${SEARCH_ANCHOR}',`;
	if (!body.includes(anchorLine))
		die(
			"SEARCH_HIERARCHY anchor not found in scan.workflow.mjs — skill may have changed",
		);
	body = body.replace(anchorLine, () => `${SCAN_ROOT_LINE}\n${anchorLine}`);

	const consts =
		"\n// --- worktree-scoped consts (injected by dg-skills monolith worktree-gen) ---\n" +
		`const mode = ${JSON.stringify(mode)};\n` +
		`const monolithPath = ${JSON.stringify(monolithPath)};\n` +
		`const stagingPath = ${JSON.stringify(stagingPath)};\n` +
		`const existingTerms = ${JSON.stringify(existingTerms)};\n` +
		`const existingFileContent = ${JSON.stringify(existingFileContent)};\n` +
		`const template = ${JSON.stringify(readFileSync(templateSource, "utf8"))};\n` +
		`const agentTypes = ${JSON.stringify(agentTypes)};\n` +
		`const SCAN_ROOT = ${JSON.stringify(worktreePath)};\n`;

	const insertAt = body.indexOf("}\n") + 2;
	if (insertAt < 2)
		die("could not find meta export closing brace in scan.workflow.mjs");
	const script = body.slice(0, insertAt) + consts + body.slice(insertAt);

	const outputPath =
		outFile ??
		path.join(
			scratchDir("monolith", { cwd: worktreePath }),
			"scan.worktree.mjs",
		);
	writeFileSync(outputPath, script);

	let ok = true;
	for (const expected of REQUIRED_CONSTS) {
		if (!script.includes(expected)) {
			process.stderr.write(`warn: missing expected const: '${expected}'\n`);
			ok = false;
		}
	}
	if (script.includes("} = args || {}")) {
		process.stderr.write(
			"warn: args destructure still present: '} = args || {}'\n",
		);
		ok = false;
	}
	const defined = script.indexOf("const SCAN_ROOT =");
	const used = script.indexOf("SCAN ROOT:");
	if (defined === -1 || used === -1 || defined > used) {
		process.stderr.write(
			"warn: SCAN_ROOT defined after or missing before its use in SEARCH_HIERARCHY\n",
		);
		ok = false;
	}
	if (!ok) {
		rmSync(outputPath, { force: true });
		die(`generated script may be malformed: ${outputPath}`);
	}

	process.stdout.write(`${outputPath}\n`);
	return EXIT.OK;
}

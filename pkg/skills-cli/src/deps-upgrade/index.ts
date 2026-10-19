import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { protectedPushReason } from "@dg/common";
import { stateDir } from "@dg/common/node";
import { detectProvider } from "../provider/detect";
import { getProvider } from "../provider/index";
import { gh, git, remoteDefaultBranch, ShellError } from "../utils/git";
import { defineCommand, die } from "../utils/legacy-command";
import { createWorktree } from "./worktree-compat";

const DESCRIPTION = `deps-upgrade — language-agnostic wrapper for the /deps-upgrade skill.
Git, provider and ecosystem operations run through the compiled CLI.

Supported ecosystems: bun, pnpm, yarn, npm, go, rust, dotnet, ruby, python.

USAGE (run any subcommand with --help for details):
  deps-upgrade prepare
  deps-upgrade list-prs
  deps-upgrade pr-body <number>
  deps-upgrade audit [--ecosystem <name>]
  deps-upgrade install [--ecosystem <name>]
  deps-upgrade audit-fix [--ecosystem <name>]
  deps-upgrade bump-dep <pkg> <old> <new> [--files a,b] [--ecosystem <name>]
  deps-upgrade bump-action <action-ref> <from> <to> [workflow-files...]
  deps-upgrade commit <type> <scope> "<msg>" [--files a,b]
  deps-upgrade status
  deps-upgrade summary
  deps-upgrade reset-deps --confirm
  deps-upgrade close-prs <n>...
  deps-upgrade cooldown <pkg> <old> <new> [--cooldown-days N] [--ecosystem <name>]
  deps-upgrade push-pr ["<title>"] [--ready]      # body on stdin; opens as draft
  deps-upgrade ready-when-green <pr> [--repo o/n] [--timeout-minutes N] [--interval-seconds N]`;

const DEFAULT_RENOVATE_LOGIN = "renovate-bot";
const DEFAULT_BRANCH_PREFIX = "chore/";

/** Resolve the deps branch prefix from DG_DEPS_BRANCH_PREFIX, defaulting to chore/. */
export function branchPrefix(): string {
	return process.env.DG_DEPS_BRANCH_PREFIX || DEFAULT_BRANCH_PREFIX;
}

/** Resolve the configured Renovate author, defaulting to renovate-bot. */
export function renovateLogin(): string {
	return process.env.AI_RENOVATE_BOT_LOGIN || DEFAULT_RENOVATE_LOGIN;
}

/** Return portable help text without executing any operation. */
export function description(): string {
	return DESCRIPTION;
}

/** Resolve validated run snapshots shared by the primary checkout and linked worktrees. */
export function scratchPaths() {
	const dir = stateDir("deps-upgrade");
	return {
		closedLog: path.join(dir, "closed-prs.txt"),
		auditBefore: path.join(dir, "audit-before.json"),
		auditAfter: path.join(dir, "audit-after.json"),
		branchFile: path.join(dir, "branch.txt"),
		heldLog: path.join(dir, "held-by-cooldown.jsonl"),
	};
}

type Cmd = readonly [bin: string, ...args: string[]];

async function runCommand(
	bin: string,
	args: string[],
	opts: { capture?: boolean; quiet?: boolean } = {},
) {
	const proc = Bun.spawn([bin, ...args], {
		stdout: opts.capture ? "pipe" : opts.quiet ? "ignore" : "inherit",
		stderr: opts.capture ? "pipe" : opts.quiet ? "ignore" : "inherit",
	});
	const [stdout, stderr] = await Promise.all([
		opts.capture ? new Response(proc.stdout).text() : Promise.resolve(""),
		opts.capture ? new Response(proc.stderr).text() : Promise.resolve(""),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr };
}

async function mustCommand([bin, ...args]: Cmd): Promise<void> {
	const { code } = await runCommand(bin, args);
	if (code !== 0) die(`command failed: ${bin} ${args.join(" ")}`);
}

function listDir(): string[] {
	try {
		return readdirSync(".");
	} catch {
		return [];
	}
}

function readTextIfExists(file: string): string {
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readLines(file: string): string[] {
	return readTextIfExists(file).split("\n").filter(Boolean);
}

/** Rewrite existing files only when transformed content differs; return changed paths. */
export function editFiles(
	files: readonly string[],
	transform: (src: string) => string,
): string[] {
	return files
		.filter((f) => existsSync(f))
		.map((file) => {
			const src = readFileSync(file, "utf8");
			return { file, src, next: transform(src) };
		})
		.filter(({ src, next }) => next !== src)
		.map(({ file, next }) => {
			writeFileSync(file, next);
			return file;
		});
}

/** Quote a literal dependency or action name for regular expressions. */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Legacy parser result, retaining unrecognized flags and positional order. */
export interface Parsed {
	positional: string[];
	flags: Record<string, string | boolean>;
}

/** Parse declared value/bool flags while retaining permissive legacy unknown flags. */
export function parseArgs(
	argv: readonly string[],
	flagNames: readonly string[] = [],
): Parsed {
	const valueFlags = new Set(
		flagNames.filter((f) => f.endsWith("=")).map((f) => f.replace("=", "")),
	);
	const boolFlags = new Set(flagNames.filter((f) => !f.endsWith("=")));
	const withFlag = (
		acc: Parsed,
		name: string,
		value: string | boolean,
	): Parsed => ({
		...acc,
		flags: { ...acc.flags, [name]: value },
	});
	const step = (rest: readonly string[], acc: Parsed): Parsed => {
		if (!rest.length) return acc;
		const [a, ...tail] = rest;
		if (!a.startsWith("--"))
			return step(tail, { ...acc, positional: [...acc.positional, a] });
		const name = a.slice(2);
		if (valueFlags.has(name))
			return step(tail.slice(1), withFlag(acc, name, tail[0]));
		if (boolFlags.has(name)) return step(tail, withFlag(acc, name, true));
		if (name.includes("=")) {
			const [k, v] = name.split("=");
			return step(tail, withFlag(acc, k, v));
		}
		return step(tail, withFlag(acc, name, true));
	};
	return step(argv, { positional: [], flags: {} });
}

/** Trim comma-separated file arguments and discard empty entries. */
export function splitList(v: unknown): string[] {
	if (typeof v !== "string") return [];
	return v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

const NPM_SEVERITIES = ["critical", "high", "moderate", "low", "info"] as const;

/** Render npm-compatible vulnerability metadata with bounded raw fallback. */
export function summarizeNpmAudit(raw: string): string {
	try {
		const data = JSON.parse(raw);
		const v = data?.metadata?.vulnerabilities ?? {};
		const vulns = (data?.vulnerabilities ?? {}) as Record<
			string,
			{ severity?: string; fixAvailable?: unknown }
		>;
		const fixable = Object.keys(vulns).filter(
			(k) => vulns[k]?.fixAvailable === true,
		);
		return [
			"=== audit summary ===",
			...NPM_SEVERITIES.filter((sev) => v[sev]).map(
				(sev) => `  ${sev}: ${v[sev]}`,
			),
			...(v.total != null ? [`  total: ${v.total}`] : []),
			...Object.entries(vulns).map(
				([name, vuln]) =>
					`  ${name}: ${vuln.severity ?? "unknown"}; fixAvailable=${JSON.stringify(vuln.fixAvailable ?? false)}`,
			),
			...(fixable.length
				? ["Directly fixable (non-breaking):", ...fixable.map((k) => `  ${k}`)]
				: []),
		].join("\n");
	} catch {
		return `=== audit ===\n(could not parse JSON; raw below)\n${raw.slice(0, 2000)}`;
	}
}

/** Decode concatenated top-level JSON objects, indented or not; malformed tails are dropped. */
export function decodeJsonStream(raw: string): unknown[] {
	const values: unknown[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}" && depth > 0 && --depth === 0) {
			try {
				values.push(JSON.parse(raw.slice(start, i + 1)));
			} catch {}
		}
	}
	return values;
}

/** Count distinct OSV findings in govulncheck's JSON object stream. */
export function summarizeGovulncheck(raw: string): string {
	const vulns = new Set(
		decodeJsonStream(raw).flatMap((entry) => {
			const osv = (entry as { finding?: { osv?: unknown } })?.finding?.osv;
			return typeof osv === "string" ? [osv] : [];
		}),
	);
	return `=== govulncheck ===\n  vulnerabilities: ${vulns.size}\n  ${[...vulns].join("\n  ")}`;
}

/** Render Cargo advisory findings or a parse-failure marker. */
export function summarizeCargoAudit(raw: string): string {
	try {
		const data = JSON.parse(raw);
		const list = (data?.vulnerabilities?.list ?? []) as Array<{
			advisory?: { id?: string };
			package?: { name?: string };
		}>;
		return [
			"=== cargo audit ===",
			`  vulnerabilities: ${data?.vulnerabilities?.count ?? 0}`,
			...list.map((v) => `  ${v.advisory?.id} (${v.package?.name})`),
		].join("\n");
	} catch {
		return "=== cargo audit ===\n(could not parse JSON)";
	}
}

/** Render vulnerable top-level and transitive .NET packages. */
export function summarizeDotnetVuln(raw: string): string {
	try {
		const data = JSON.parse(raw);
		const header =
			"=== dotnet list package --vulnerable --include-transitive ===";
		const lines = (
			(data?.projects ?? []) as Array<{
				frameworks?: Array<Record<string, unknown>>;
			}>
		)
			.flatMap((p) => p.frameworks ?? [])
			.flatMap((f) => [
				...((f.topLevelPackages ?? []) as DotnetPackage[]),
				...((f.transitivePackages ?? []) as DotnetPackage[]),
			])
			.filter((pkg) => pkg.vulnerabilities?.length)
			.map(
				(pkg) =>
					`  ${pkg.id}@${pkg.resolvedVersion} — ${pkg.vulnerabilities?.length} advisories`,
			);
		return lines.length
			? [header, ...lines].join("\n")
			: `${header}\n  no vulnerabilities`;
	} catch {
		return "=== dotnet ===\n(could not parse JSON)";
	}
}

interface DotnetPackage {
	id?: string;
	resolvedVersion?: string;
	vulnerabilities?: unknown[];
}

/** Summarize Python package vulnerability counts or a parse-failure marker. */
export function summarizePipAudit(raw: string): string {
	try {
		const deps = (JSON.parse(raw)?.dependencies ?? []) as Array<{
			vulns?: unknown[];
		}>;
		return `vulnerable packages: ${deps.filter((d) => d.vulns?.length).length}`;
	} catch {
		return "(could not parse JSON)";
	}
}

/** Marker, manifest, installer, audit and bump contracts for one ecosystem. */
export interface EcosystemSpec {
	markers: ReadonlyArray<string | RegExp>;
	lockFile: (entries: readonly string[]) => string | null;
	installCommand: (entries: readonly string[]) => Cmd | null;
	audit: { command: Cmd; summarize: (raw: string) => string };
	auditFix: Cmd | null;
	bump: (pkg: string, oldV: string, newV: string) => Promise<string[]>;
}

type NodeEcosystem = "bun" | "pnpm" | "yarn" | "npm";

const NODE_DEP_SECTIONS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

/** Preserve arbitrary manifest fields alongside supported dependency sections. */
export type NodeManifest = Record<string, unknown> &
	Partial<Record<(typeof NODE_DEP_SECTIONS)[number], Record<string, string>>>;

/** Resolve the root manifest and the manifests that workspace globs match. */
export function nodeManifests(): string[] {
	const { workspaces } = JSON.parse(readFileSync("package.json", "utf8"));
	const patterns: unknown[] = Array.isArray(workspaces)
		? workspaces
		: Array.isArray(workspaces?.packages)
			? workspaces.packages
			: [];
	const strings = patterns.filter((p): p is string => typeof p === "string");
	const manifestGlob = (p: string) =>
		new Bun.Glob(path.posix.join(p, "package.json"));
	const excluded = strings
		.filter((p) => p.startsWith("!"))
		.map((p) => manifestGlob(p.slice(1)));
	const found = strings
		.filter((p) => !p.startsWith("!"))
		.flatMap((p) => [...manifestGlob(p).scanSync(".")].sort())
		.filter(
			(file) =>
				!file.split("/").includes("node_modules") &&
				!excluded.some((glob) => glob.match(file)),
		);
	return ["package.json", ...new Set(found)];
}

/** Replace an existing dependency version, preserving its caret/tilde prefix. */
export function withBumpedVersion(
	manifest: NodeManifest,
	pkg: string,
	newV: string,
): NodeManifest {
	return NODE_DEP_SECTIONS.filter(
		(s) => manifest[s] && Object.hasOwn(manifest[s], pkg),
	).reduce<NodeManifest>(
		(acc, s) => ({
			...acc,
			[s]: {
				...acc[s],
				[pkg]: `${String(acc[s]?.[pkg]).match(/^[\^~]?/)?.[0] ?? ""}${newV}`,
			},
		}),
		manifest,
	);
}

/** Rewrite matching root/workspace manifests; terminate if the package is absent. */
export function bumpNodePackage(
	pkg: string,
	_oldV: string,
	newV: string,
): string[] {
	const changed = nodeManifests()
		.map((file) => {
			const text = readFileSync(file, "utf8");
			const before = JSON.parse(text) as NodeManifest;
			return { file, text, before, after: withBumpedVersion(before, pkg, newV) };
		})
		.filter(({ before, after }) => before !== after);
	if (!changed.length)
		die(`${pkg} not found in package.json or its workspaces`);
	changed.forEach(({ file, text, after }) =>
		writeFileSync(
			file,
			`${JSON.stringify(after, null, text.match(/^[ \t]+(?=")/m)?.[0] ?? 2)}\n`,
		),
	);
	return changed.map(({ file }) => file);
}

/** Replace a simple or inline-table Cargo version without altering unrelated text. */
export function bumpCargoToml(src: string, pkg: string, newV: string): string {
	const name = escapeRegex(pkg);
	const patterns = [
		new RegExp(`(^${name}\\s*=\\s*")[^"]+(")`, "gm"),
		new RegExp(`(^${name}\\s*=\\s*\\{[^}]*version\\s*=\\s*")[^"]+(")`, "gm"),
	];
	return patterns.reduce((out, re) => out.replace(re, `$1${newV}$2`), src);
}

/** Replace the named gem version while retaining its version operator. */
export function bumpGemfile(src: string, pkg: string, newV: string): string {
	const re = new RegExp(
		`(gem\\s+['"]${escapeRegex(pkg)}['"]\\s*,\\s*['"](?:[~<>=!]+\\s*)?)(?=\\d)[^'"]+(['"])`,
	);
	return src.replace(re, `$1${newV}$2`);
}

/** Replace matching pinned Python versions while retaining their comparison syntax. */
export function bumpPythonSource(
	src: string,
	pkg: string,
	oldV: string,
	newV: string,
): string {
	const re = new RegExp(
		`((?:^|\\n)\\s*["']?${escapeRegex(pkg)}["']?\\s*[=~<>]{1,2}\\s*["']?)${escapeRegex(oldV)}(?![\\w.])(["']?)`,
		"g",
	);
	return src.replace(re, `$1${newV}$2`);
}

/** Replace matching action refs, including subpaths, while retaining an existing v prefix. */
export function bumpActionRefs(
	src: string,
	action: string,
	fromTag: string,
	toTag: string,
): string {
	const re = new RegExp(
		`((?<![\\w./-])${escapeRegex(action)}(?:/[^@\\s]+)?)@(v?)${escapeRegex(fromTag)}(?=\\s|$)`,
		"g",
	);
	return src.replace(re, (_m, ref, v) => `${ref}@${v}${toTag}`);
}

const csprojFiles = (entries: readonly string[]): string[] =>
	entries.filter((f) => f.endsWith(".csproj"));

const nodeEcosystem = (
	eco: NodeEcosystem,
	opts: Pick<EcosystemSpec, "markers" | "lockFile" | "auditFix"> & {
		audit: Cmd;
	},
): EcosystemSpec => ({
	markers: opts.markers,
	lockFile: opts.lockFile,
	installCommand: () => [eco, "install"],
	audit: { command: opts.audit, summarize: summarizeNpmAudit },
	auditFix: opts.auditFix,
	bump: async (pkg, oldV, newV) => {
		const changed = bumpNodePackage(pkg, oldV, newV);
		await runInstall(eco);
		return changed;
	},
});

/** Ordered ecosystem implementations; detection uses the first matching marker. */
export const ECOSYSTEMS = {
	bun: nodeEcosystem("bun", {
		markers: ["bun.lockb", "bun.lock"],
		lockFile: (entries) =>
			entries.includes("bun.lock") ? "bun.lock" : "bun.lockb",
		audit: ["bun", "audit", "--json"],
		auditFix: ["bun", "audit", "fix"],
	}),
	pnpm: nodeEcosystem("pnpm", {
		markers: ["pnpm-lock.yaml"],
		lockFile: () => "pnpm-lock.yaml",
		audit: ["pnpm", "audit", "--json"],
		auditFix: ["pnpm", "audit", "--fix"],
	}),
	yarn: nodeEcosystem("yarn", {
		markers: ["yarn.lock"],
		lockFile: () => "yarn.lock",
		audit: ["yarn", "npm", "audit", "--json"],
		auditFix: ["yarn", "npm", "audit", "--fix"],
	}),
	npm: nodeEcosystem("npm", {
		markers: ["package-lock.json"],
		lockFile: () => "package-lock.json",
		audit: ["npm", "audit", "--json"],
		auditFix: ["npm", "audit", "fix"],
	}),
	go: {
		markers: ["go.mod"],
		lockFile: () => "go.sum",
		installCommand: () => ["go", "mod", "tidy"],
		audit: {
			command: ["govulncheck", "-json", "./..."],
			summarize: summarizeGovulncheck,
		},
		auditFix: null,
		bump: async (pkg, _oldV, newV) => {
			await mustCommand(["go", "get", `${pkg}@v${newV.replace(/^v/, "")}`]);
			await mustCommand(["go", "mod", "tidy"]);
			return ["go.mod"];
		},
	},
	rust: {
		markers: ["Cargo.toml"],
		lockFile: () => "Cargo.lock",
		installCommand: () => ["cargo", "build", "--locked"],
		audit: {
			command: ["cargo", "audit", "--json"],
			summarize: summarizeCargoAudit,
		},
		auditFix: null,
		bump: async (pkg, _oldV, newV) => {
			const changed = editFiles(["Cargo.toml"], (src) =>
				bumpCargoToml(src, pkg, newV),
			);
			await mustCommand(["cargo", "update", "-p", pkg, "--precise", newV]);
			return changed;
		},
	},
	dotnet: {
		markers: [/\.(csproj|sln)$/],
		lockFile: () => null,
		installCommand: () => ["dotnet", "restore"],
		audit: {
			command: [
				"dotnet",
				"list",
				"package",
				"--vulnerable",
				"--include-transitive",
				"--format",
				"json",
			],
			summarize: summarizeDotnetVuln,
		},
		auditFix: null,
		bump: async (pkg, _oldV, newV) => {
			const projects = csprojFiles(listDir());
			if (!projects.length) die("no .csproj in cwd");
			const touched = projects.filter((p) =>
				readFileSync(p, "utf8").includes(`Include="${pkg}"`),
			);
			for (const p of touched)
				await mustCommand([
					"dotnet",
					"add",
					p,
					"package",
					pkg,
					"--version",
					newV,
				]);
			return touched;
		},
	},
	ruby: {
		markers: ["Gemfile"],
		lockFile: () => "Gemfile.lock",
		installCommand: () => ["bundle", "install"],
		audit: {
			command: ["bundle-audit", "check", "--format", "json"],
			summarize: (raw) => `=== bundle audit ===\n${raw || "(no output)"}`,
		},
		auditFix: null,
		bump: async (pkg, _oldV, newV) => {
			const changed = editFiles(["Gemfile"], (src) =>
				bumpGemfile(src, pkg, newV),
			);
			await mustCommand(["bundle", "update", "--conservative", pkg]);
			return changed;
		},
	},
	python: {
		markers: ["pyproject.toml", "requirements.txt"],
		lockFile: (entries) =>
			["poetry.lock", "uv.lock"].find((f) => entries.includes(f)) ?? null,
		installCommand: (entries) =>
			entries.includes("uv.lock")
				? ["uv", "sync"]
				: entries.includes("poetry.lock")
					? ["poetry", "install"]
					: entries.includes("requirements.txt")
						? ["pip", "install", "-r", "requirements.txt"]
						: null,
		audit: {
			command: ["pip-audit", "--format", "json"],
			summarize: (raw) => `=== pip-audit ===\n${summarizePipAudit(raw)}`,
		},
		auditFix: null,
		bump: async (pkg, oldV, newV) => {
			const changed = editFiles(["pyproject.toml", "requirements.txt"], (src) =>
				bumpPythonSource(src, pkg, oldV, newV),
			);
			await runInstall("python");
			return changed;
		},
	},
} satisfies Record<string, EcosystemSpec>;

/** Supported ecosystem identifiers from the ordered implementation table. */
export type Ecosystem = keyof typeof ECOSYSTEMS;

const SPECS: Record<Ecosystem, EcosystemSpec> = ECOSYSTEMS;

/** Detection order shared with validation and help diagnostics. */
export const ECOSYSTEM_NAMES = Object.keys(ECOSYSTEMS) as Ecosystem[];

/** Validate an exact supported ecosystem name; return null for unknown names. */
export function parseEcosystem(name: string): Ecosystem | null {
	return Object.hasOwn(ECOSYSTEMS, name) ? (name as Ecosystem) : null;
}

/** Select the first ecosystem whose markers match the supplied directory entries. */
export function detectEcosystem(entries: readonly string[]): Ecosystem | null {
	return (
		ECOSYSTEM_NAMES.find((eco) =>
			SPECS[eco].markers.some((m) =>
				entries.some((e) => (typeof m === "string" ? e === m : m.test(e))),
			),
		) ?? null
	);
}

/** Resolve an explicit override or detect markers; terminate on invalid/missing input. */
export function resolveEcosystem(
	override?: string,
	entries: readonly string[] = listDir(),
): Ecosystem {
	if (override)
		return parseEcosystem(override) ?? die(`unknown --ecosystem: ${override}`);
	return (
		detectEcosystem(entries) ??
		die("no supported ecosystem detected (pass --ecosystem to override)")
	);
}

function announcedEcosystem(flags: Parsed["flags"]): Ecosystem {
	const eco = resolveEcosystem(flags.ecosystem as string | undefined);
	process.stderr.write(`ecosystem: ${eco}\n`);
	return eco;
}

async function runInstall(eco: Ecosystem): Promise<void> {
	const command = SPECS[eco].installCommand(listDir());
	if (!command) die("no python install strategy detected");
	await mustCommand(command);
}

const firstOutput = async (
	bin: string,
	args: string[],
): Promise<string | null> =>
	(await runCommand(bin, args, { capture: true })).stdout.trim() || null;

const DEFAULT_BRANCH_PROBES: ReadonlyArray<() => Promise<string | null>> = [
	async () =>
		(await git`symbolic-ref refs/remotes/origin/HEAD`)
			.text()
			.trim()
			.replace("refs/remotes/origin/", "") || null,
	() =>
		firstOutput("gh", [
			"repo",
			"view",
			"--json",
			"defaultBranchRef",
			"--jq",
			".defaultBranchRef.name",
		]),
	async () =>
		(await firstOutput("git", ["ls-remote", "--heads", "origin", "main"]))
			? "main"
			: null,
	async () =>
		(await firstOutput("git", ["ls-remote", "--heads", "origin", "master"]))
			? "master"
			: null,
];

async function resolveDefaultBranch(): Promise<string> {
	for (const probe of DEFAULT_BRANCH_PROBES) {
		const name = await probe().catch(() => null);
		if (name) return name;
	}
	return "main";
}

const ACTION_COMMIT = /actions\/|github\/codeql-action/;

/** Count dependency and GitHub Action bump subjects separately. */
export function countBumps(commits: readonly string[]): {
	bumpDep: number;
	bumpAction: number;
} {
	return {
		bumpDep: commits.filter(
			(c) => /(?:build|chore)\(deps\): bump /.test(c) && !ACTION_COMMIT.test(c),
		).length,
		bumpAction: commits.filter((c) => ACTION_COMMIT.test(c)).length,
	};
}

/** Describe npm-compatible audit totals, retaining unknown-report placeholders. */
export function describeAudit(raw: string): string | null {
	if (!raw.trim()) return null;
	try {
		const v = JSON.parse(raw)?.metadata?.vulnerabilities;
		if (v) {
			const parts = ["critical", "high", "moderate", "low"]
				.filter((k) => v[k])
				.map((k) => `${v[k]} ${k}`);
			return parts.length
				? `${v.total ?? "?"} total (${parts.join(", ")})`
				: `${v.total ?? 0} total`;
		}
	} catch {}
	return "(see scratch file)";
}

/** Collected branch, commit, audit and cooldown evidence for the run report. */
export interface SummaryInput {
	ecosystem: string;
	branch: string;
	defaultBranch: string;
	commits: readonly string[];
	closed: readonly string[];
	before: string | null;
	after: string | null;
	held?: readonly HeldEntry[];
}

/** Durable skipped/fallback dependency evidence recorded as JSON lines. */
export interface HeldEntry {
	pkg: string;
	version: string;
	published: string | null;
	eligible: string | null;
	usedVersion?: string;
}

const heldLine = (h: HeldEntry): string =>
	`  - ${h.pkg}@${h.version} — ` +
	(h.published && h.eligible
		? `published ${h.published.slice(0, 10)}, eligible ${h.eligible.slice(0, 10)}`
		: "unknown age") +
	(h.usedVersion ? `, upgraded to ${h.usedVersion} instead` : "");

/** Render the run report with counts, audit delta and held-version evidence. */
export function renderSummary(s: SummaryInput): string {
	const { bumpDep, bumpAction } = countBumps(s.commits);
	return [
		"## Run summary",
		"",
		`Ecosystem: ${s.ecosystem}`,
		`Branch: ${s.branch}`,
		`Applied: ${bumpDep} dependencies, ${bumpAction} GitHub Actions`,
		"",
		`Commits on ${s.branch} since origin/${s.defaultBranch}:`,
		...(s.commits.length ? s.commits.map((c) => `  ${c}`) : ["  (none)"]),
		"",
		`Closed PRs/MRs: ${s.closed.length ? s.closed.map((n) => `#${n}`).join(", ") : "(none)"}`,
		"",
		`Vulnerabilities: ${s.before ?? "?"} → ${s.after ?? "(not re-audited)"}`,
		...(s.held?.length
			? ["", `Held by cooldown (${s.held.length}):`, ...s.held.map(heldLine)]
			: []),
	].join("\n");
}

/** Format a UTC timestamp; worktree creation normalizes its separators to underscores. */
export function timestampSlug(date: Date): string {
	const iso = date.toISOString();
	return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

/** Default minimum package publication age for dependency updates. */
export const DEFAULT_COOLDOWN_DAYS = 7;
const DAY_MS = 86_400_000;
const STABLE_VERSION = /^v?\d+(\.\d+)*$/;

/** Order dotted numeric versions; a leading v and non-numeric parts count as zero. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (x[i] ?? 0) - (y[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Injectable registry transport; null represents unavailable metadata. */
export type FetchJson = (url: string) => Promise<unknown>;
type Releases = Record<string, string>;
type Registry = (
	pkg: string,
	version: string,
	fetchJson: FetchJson,
) => Promise<Releases>;

/** Fetch registry metadata with a timeout; unavailable or malformed responses return null. */
export const fetchJson: FetchJson = async (url) => {
	try {
		const res = await fetch(url, {
			headers: { "user-agent": "deps-upgrade", accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
};

const isoMap = (entries: ReadonlyArray<readonly [string, unknown]>): Releases =>
	Object.fromEntries(
		entries.filter(
			(e): e is [string, string] =>
				typeof e[1] === "string" && !Number.isNaN(Date.parse(e[1])),
		),
	);

interface NugetNode {
	"@id"?: string;
	items?: NugetNode[];
	catalogEntry?: { version: string; published: unknown };
}

const npmReleases: Registry = async (pkg, _v, get) => {
	const doc = (await get(
		`https://registry.npmjs.org/${pkg.replace("/", "%2F")}`,
	)) as {
		time?: Record<string, unknown>;
	} | null;
	return isoMap(Object.entries(doc?.time ?? {}));
};

const pypiReleases: Registry = async (pkg, _v, get) => {
	const doc = (await get(`https://pypi.org/pypi/${pkg}/json`)) as {
		releases?: Record<string, Array<{ upload_time_iso_8601?: unknown }>>;
	} | null;
	return isoMap(
		Object.entries(doc?.releases ?? {}).map(([v, files]) => [
			v,
			files[0]?.upload_time_iso_8601,
		]),
	);
};

const nugetReleases: Registry = async (pkg, _v, get) => {
	const index = (await get(
		`https://api.nuget.org/v3/registration5-gz-semver2/${pkg.toLowerCase()}/index.json`,
	)) as NugetNode | null;
	const pages = await Promise.all(
		(index?.items ?? []).map(
			async (page) =>
				page.items ??
				((await get(page["@id"] ?? "")) as NugetNode | null)?.items ??
				[],
		),
	);
	return isoMap(
		pages
			.flat()
			.map((i) => [i.catalogEntry?.version ?? "", i.catalogEntry?.published]),
	);
};

const cratesReleases: Registry = async (pkg, _v, get) => {
	const doc = (await get(`https://crates.io/api/v1/crates/${pkg}`)) as {
		versions?: Array<{ num: string; created_at: unknown }>;
	} | null;
	return isoMap((doc?.versions ?? []).map((v) => [v.num, v.created_at]));
};

const rubygemsReleases: Registry = async (pkg, _v, get) => {
	const doc = (await get(
		`https://rubygems.org/api/v1/versions/${pkg}.json`,
	)) as Array<{
		number: string;
		created_at: unknown;
	}> | null;
	return isoMap((doc ?? []).map((v) => [v.number, v.created_at]));
};

const goReleases: Registry = async (pkg, version, get) => {
	const encoded = pkg.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
	const tag = `v${version.replace(/^v/, "")}`;
	const doc = (await get(
		`https://proxy.golang.org/${encoded}/@v/${tag}.info`,
	)) as { Time?: unknown } | null;
	return isoMap([[version, doc?.Time]]);
};

const REGISTRIES: Record<Ecosystem, Registry> = {
	bun: npmReleases,
	pnpm: npmReleases,
	yarn: npmReleases,
	npm: npmReleases,
	go: goReleases,
	rust: cratesReleases,
	dotnet: nugetReleases,
	ruby: rubygemsReleases,
	python: pypiReleases,
};

/** Allow the request, use an eligible fallback, hold it, or flag unknown publication age. */
export type CooldownVerdict =
	| { status: "ok"; version: string }
	| {
			status: "fallback";
			version: string;
			requested: string;
			published: string;
			eligible: string;
	  }
	| { status: "held"; requested: string; published: string; eligible: string }
	| { status: "unknown"; requested: string };

/** Registry lookup inputs with injectable time and transport for deterministic evaluation. */
export interface CooldownInput {
	eco: Ecosystem;
	pkg: string;
	oldVersion: string;
	version: string;
	days: number;
	now?: () => number;
	fetchJson?: FetchJson;
}

/** Check publication age and choose the newest eligible stable fallback after the current release. */
export async function evaluateCooldown(
	input: CooldownInput,
): Promise<CooldownVerdict> {
	const {
		eco,
		pkg,
		oldVersion,
		version,
		days,
		now = Date.now,
		fetchJson: get = fetchJson,
	} = input;
	if (days <= 0) return { status: "ok", version };
	const releases = await REGISTRIES[eco](pkg, version, get);
	const published = releases[version];
	if (!published) return { status: "unknown", requested: version };
	const cutoff = now() - days * DAY_MS;
	if (Date.parse(published) <= cutoff) return { status: "ok", version };

	const eligible = new Date(
		Date.parse(published) + days * DAY_MS,
	).toISOString();
	const fallback = Object.entries(releases)
		.filter(
			([v, at]) =>
				STABLE_VERSION.test(v) &&
				Date.parse(at) <= cutoff &&
				compareVersions(v, oldVersion) > 0 &&
				compareVersions(v, version) < 0,
		)
		.sort(([a], [b]) => compareVersions(b, a))[0];
	return fallback
		? {
				status: "fallback",
				version: fallback[0],
				requested: version,
				published,
				eligible,
			}
		: { status: "held", requested: version, published, eligible };
}

/** Convert held, unknown or fallback verdicts to durable report evidence. */
export function heldEntry(
	pkg: string,
	verdict: CooldownVerdict,
): HeldEntry | null {
	if (verdict.status === "ok") return null;
	if (verdict.status === "unknown")
		return { pkg, version: verdict.requested, published: null, eligible: null };
	const requested = {
		pkg,
		published: verdict.published,
		eligible: verdict.eligible,
	};
	return verdict.status === "fallback"
		? { ...requested, version: verdict.requested, usedVersion: verdict.version }
		: { ...requested, version: verdict.requested };
}

function parseDays(flag: string | boolean | undefined): number {
	if (flag === undefined) return DEFAULT_COOLDOWN_DAYS;
	const n = Number(flag);
	return Number.isInteger(n) && n >= 0
		? n
		: die(`--cooldown-days must be a whole number >= 0, got: ${flag}`);
}

/** Delay before treating a repository with no reported checks as green. */
export const CHECKS_GRACE_MS = 5 * 60_000;

/** GitHub check name and status bucket used by readiness polling. */
export interface Check {
	name: string;
	bucket: string;
}

/** Polling timing and injectable clock/sleep dependencies. */
export interface PollOptions {
	intervalMs: number;
	timeoutMs: number;
	graceMs: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

/** Readiness outcome; noChecks distinguishes grace-period completion. */
export type Verdict =
	| { status: "green"; noChecks?: true }
	| { status: "failed"; failing: string[] }
	| { status: "timeout" };

/** Wait through pending checks; fail completed checks or stop at the timeout. */
export async function pollChecks(
	fetchChecks: () => Promise<Check[]>,
	o: PollOptions,
): Promise<Verdict> {
	const start = o.now();
	for (;;) {
		const checks = await fetchChecks();
		const elapsed = o.now() - start;
		if (!checks.length && elapsed >= o.graceMs)
			return { status: "green", noChecks: true };
		if (checks.length && !checks.some((c) => c.bucket === "pending")) {
			const failing = checks
				.filter((c) => c.bucket === "fail" || c.bucket === "cancel")
				.map((c) => c.name);
			return failing.length
				? { status: "failed", failing }
				: { status: "green" };
		}
		if (elapsed >= o.timeoutMs) return { status: "timeout" };
		await o.sleep(o.intervalMs);
	}
}

async function fetchPrChecks(
	ref: string,
	repoFlags: string[],
): Promise<Check[]> {
	try {
		return JSON.parse(
			(await gh`pr checks ${ref} ${repoFlags} --json name,bucket`).text(),
		);
	} catch (e) {
		if (!(e instanceof ShellError)) throw e;
		const out = e.stdout.toString().trim();
		if (out.startsWith("[")) return JSON.parse(out);
		if (/no checks reported/i.test(e.stderr.toString())) return [];
		throw e;
	}
}

async function refuseProtectedBranch(): Promise<void> {
	const branch = (await git`rev-parse --abbrev-ref HEAD`).text().trim();
	if (protectedPushReason(branch, await remoteDefaultBranch()))
		die(
			`refusing to run on protected branch '${branch}'; cd into the deps worktree first`,
		);
}

function numberFlag(
	name: string,
	flag: string | boolean | undefined,
	fallback: number,
	min = 0,
): number {
	if (flag === undefined) return fallback;
	const n = Number(flag);
	return Number.isFinite(n) && n >= min
		? n
		: die(`--${name} must be a number >= ${min}, got: ${flag}`);
}

async function cmdPrepare() {
	const base = await resolveDefaultBranch();
	await git`fetch origin ${base}`;

	const diagnostics: string[] = [];
	const { path: wtPath, branch: wtBranch } = await createWorktree(
		{
			slug: `deps-update-${timestampSlug(new Date())}`,
			prefix: branchPrefix(),
			base,
		},
		(text) => {
			diagnostics.push(text);
		},
	).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		die(
			`worktree-cli create failed:\n${diagnostics.join("")}worktree-cli: ${message}\n`,
		);
	});

	const scratch = scratchPaths();
	[
		scratch.closedLog,
		scratch.auditBefore,
		scratch.auditAfter,
		scratch.heldLog,
	].forEach((f) => writeFileSync(f, ""));
	writeFileSync(scratch.branchFile, `${wtBranch}\n`);

	process.stdout.write(
		`Worktree ready.\n  branch: ${wtBranch}\n  path:   ${wtPath}\n\n` +
			`Run every remaining step from inside the worktree:\n  cd ${wtPath}\n`,
	);
}

async function cmdListPrs() {
	const { kind } = await detectProvider();
	if (kind === "github") {
		const result =
			await gh`pr list --label dependencies --state open --limit 50 --json number,title,headRefName`;
		process.stdout.write(result.text());
		return;
	}

	const login = renovateLogin();
	const provider = await getProvider();
	const prs = await provider.listPullRequests({ author: login, state: "open" });
	if (prs.length === 0) {
		process.stderr.write(
			`found 0 open MRs authored by ${login} — confirm this repo uses Renovate under that login\n`,
		);
	}
	process.stdout.write(`${JSON.stringify(prs)}\n`);
}

function pullRequestNumber(value: string): number {
	return /^[1-9]\d*$/.test(value)
		? Number(value)
		: die(`pull request number must be a positive integer, got: ${value}`);
}

async function cmdPrBody(args: string[]) {
	const n = args[0];
	if (!n) die("pr-body requires a PR number");
	const number = pullRequestNumber(n);
	const provider = await getProvider();
	const body = await provider.getPullRequestBody({ number });
	process.stdout.write(body);
}

async function cmdAudit(args: string[]) {
	const { flags } = parseArgs(args, ["ecosystem="]);
	const { audit } = SPECS[announcedEcosystem(flags)];
	const [bin, ...cmdArgs] = audit.command;
	const { stdout } = await runCommand(bin, cmdArgs, { capture: true });

	const scratch = scratchPaths();
	const target = readTextIfExists(scratch.auditBefore).trim()
		? scratch.auditAfter
		: scratch.auditBefore;
	writeFileSync(target, stdout || "");

	process.stdout.write(`${audit.summarize(stdout)}\n`);
}

async function cmdInstall(args: string[]) {
	const { flags } = parseArgs(args, ["ecosystem="]);
	await runInstall(announcedEcosystem(flags));
}

async function cmdAuditFix(args: string[]) {
	const { flags } = parseArgs(args, ["ecosystem="]);
	const eco = announcedEcosystem(flags);
	const { auditFix } = SPECS[eco];
	if (!auditFix) die(`audit-fix is not supported for ${eco}`);
	await mustCommand(auditFix);
}

async function cmdBumpDep(args: string[]) {
	const { positional, flags } = parseArgs(args, ["files=", "ecosystem="]);
	const [pkg, oldV, newV] = positional;
	if (!pkg || !oldV || !newV)
		die("usage: bump-dep <pkg> <old> <new> [--files a,b] [--ecosystem <name>]");
	await refuseProtectedBranch();
	const eco = announcedEcosystem(flags);
	const spec = SPECS[eco];

	const changed = await spec.bump(pkg, oldV, newV);
	const lock = spec.lockFile(listDir());
	const toAdd = [
		...changed,
		...(lock ? [lock] : []),
		...splitList(flags.files),
	].filter((p) => existsSync(p));
	if (toAdd.length) await git`add ${toAdd}`;

	await git`commit -m ${`chore(deps): bump ${pkg} from ${oldV} to ${newV}`}`;
}

async function cmdBumpAction(args: string[]) {
	const [action, fromTag, toTag, ...files] = args;
	if (!action || !fromTag || !toTag)
		die("usage: bump-action <action-ref> <from> <to> [workflow-files...]");
	await refuseProtectedBranch();
	const targets = files.length ? files : findWorkflowFiles();
	const changed = editFiles(targets, (src) =>
		bumpActionRefs(src, action, fromTag, toTag),
	);
	if (!changed.length) die("no workflow files changed — check <from> tag");
	await git`add ${changed}`;
	await git`commit -m ${`chore(deps): bump ${action} from ${fromTag} to ${toTag}`}`;
}

/** List immediate YAML workflows; absent workflow directories return an empty list. */
export function findWorkflowFiles(): string[] {
	const dir = ".github/workflows";
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
		.map((f) => path.join(dir, f));
}

async function cmdCommit(args: string[]) {
	const { positional, flags } = parseArgs(args, ["files="]);
	const [type, scope, ...rest] = positional;
	if (!type || !scope || !rest.length)
		die('usage: commit <type> <scope> "<message>" [--files a,b]');
	await refuseProtectedBranch();
	const files = splitList(flags.files);
	if (files.length) await git`add ${files}`;
	await git`commit -m ${`${type}(${scope}): ${rest.join(" ")}`}`;
}

async function cmdStatus() {
	const s1 = (await git`status --short`).text();
	const s2 = (await git`log --oneline -10`).text();
	const s3 = (await git`diff --stat`).text();
	process.stdout.write(`--- git status --short ---\n${s1}`);
	process.stdout.write(`\n--- git log --oneline -10 ---\n${s2}`);
	process.stdout.write(`\n--- git diff --stat ---\n${s3}`);
}

async function cmdResetDeps(args: string[]) {
	const confirm = args.includes("--confirm");
	const defaultBranch = await resolveDefaultBranch();
	if (!confirm) {
		process.stdout.write(
			`reset-deps: would run \`git reset --mixed $(git merge-base HEAD origin/${defaultBranch})\`\n`,
		);
		process.stdout.write("pass --confirm to execute\n");
		return;
	}
	const base = (await git`merge-base HEAD origin/${defaultBranch}`)
		.text()
		.trim();
	if (!base) die(`could not determine merge-base with origin/${defaultBranch}`);
	await git`reset --mixed ${base}`;
}

async function cmdClosePrs(args: string[]) {
	if (!args.length) die("close-prs requires at least one PR number");
	const numbers = args.map(pullRequestNumber);
	const branch = (await git`rev-parse --abbrev-ref HEAD`).text().trim();
	const comment = `Included in combined deps branch: ${branch}`;
	const provider = await getProvider();
	const { closedLog } = scratchPaths();
	for (const n of numbers) {
		try {
			await provider.closePullRequest({ number: n }, comment);
			appendFileSync(closedLog, `${n}\n`);
		} catch (e) {
			process.stderr.write(
				`warning: failed to close PR #${n}: ${e instanceof Error ? e.message : String(e)}\n`,
			);
		}
	}
}

async function cmdPushPr(args: string[]) {
	const { positional, flags } = parseArgs(args, ["ready"]);
	const title = positional[0] ?? "chore(deps): batch dependency upgrade";
	await refuseProtectedBranch();
	const body = await Bun.stdin.text();
	await git`push -u origin HEAD`;
	const base = await resolveDefaultBranch();
	const head = (await git`rev-parse --abbrev-ref HEAD`).text().trim();
	const provider = await getProvider();
	const pr = await provider.createPullRequest({
		title,
		body,
		base,
		head,
		draft: !flags.ready,
	});
	process.stdout.write(`PR created: ${pr.url}`);
}

async function cmdCooldown(args: string[]) {
	const { positional, flags } = parseArgs(args, [
		"cooldown-days=",
		"ecosystem=",
	]);
	const [pkg, oldVersion, version] = positional;
	if (!pkg || !oldVersion || !version) {
		die(
			"usage: cooldown <pkg> <old> <new> [--cooldown-days N] [--ecosystem <name>]",
		);
	}
	const eco = announcedEcosystem(flags);
	const verdict = await evaluateCooldown({
		eco,
		pkg,
		oldVersion,
		version,
		days: parseDays(flags["cooldown-days"]),
	});
	const held = heldEntry(pkg, verdict);
	if (held) appendFileSync(scratchPaths().heldLog, `${JSON.stringify(held)}\n`);
	process.stdout.write(`${JSON.stringify({ pkg, ...verdict })}\n`);
}

async function cmdReadyWhenGreen(args: string[]) {
	const { positional, flags } = parseArgs(args, [
		"repo=",
		"timeout-minutes=",
		"interval-seconds=",
	]);
	const ref = positional[0];
	if (!ref)
		die(
			"usage: ready-when-green <pr-number|url> [--repo owner/name] [--timeout-minutes N] [--interval-seconds N]",
		);
	const intervalMs =
		numberFlag("interval-seconds", flags["interval-seconds"], 30, 1) * 1000;
	const timeoutMs =
		numberFlag("timeout-minutes", flags["timeout-minutes"], 60) * 60_000;
	const repoFlags =
		typeof flags.repo === "string" ? ["--repo", flags.repo] : [];
	const url = (await gh`pr view ${ref} ${repoFlags} --json url --jq .url`)
		.text()
		.trim();
	const verdict = await pollChecks(() => fetchPrChecks(ref, repoFlags), {
		intervalMs,
		timeoutMs,
		graceMs: CHECKS_GRACE_MS,
		now: Date.now,
		sleep: (ms) => Bun.sleep(ms),
	});
	if (verdict.status === "green") await gh`pr ready ${ref} ${repoFlags}`;
	const result =
		verdict.status === "green"
			? {
					status: "ready",
					url,
					...(verdict.noChecks ? { noChecks: true } : {}),
				}
			: { ...verdict, url };
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (verdict.status !== "green")
		process.exit({ failed: 1, timeout: 2 }[verdict.status]);
}

async function cmdSummary() {
	const defaultBranch = await resolveDefaultBranch();
	const branch = (await git`rev-parse --abbrev-ref HEAD`).text().trim();
	const logText = (
		await git`log ${`origin/${defaultBranch}..HEAD`} --oneline`
	).text();
	const scratch = scratchPaths();
	const summary = renderSummary({
		ecosystem: detectEcosystem(listDir()) ?? "(unknown)",
		branch,
		defaultBranch,
		commits: logText.trim().split("\n").filter(Boolean),
		closed: readLines(scratch.closedLog),
		before: describeAudit(readTextIfExists(scratch.auditBefore)),
		after: describeAudit(readTextIfExists(scratch.auditAfter)),
		held: readLines(scratch.heldLog).map((l) => JSON.parse(l) as HeldEntry),
	});
	process.stdout.write(`${summary}\n`);
}

/** Build the inert legacy dispatcher for all sixteen dependency operations. */
export function buildCommand() {
	return defineCommand({
		name: "deps-upgrade",
		description: description(),
		subcommands: {
			prepare: {
				description:
					"create <prefix>deps_update_<ts> worktree+branch (prefix: $DG_DEPS_BRANCH_PREFIX, default chore/), clear scratch",
				run: () => cmdPrepare(),
			},
			"list-prs": {
				description:
					"list open Dependabot PRs (GitHub) or Renovate MRs (GitLab) as JSON",
				run: () => cmdListPrs(),
			},
			"pr-body": {
				description: "print body of a PR by number",
				args: ["number"],
				run: cmdPrBody,
			},
			audit: {
				description: "run ecosystem vulnerability audit",
				run: cmdAudit,
			},
			install: { description: "install dependencies", run: cmdInstall },
			"audit-fix": {
				description: "apply non-breaking audit fixes",
				run: cmdAuditFix,
			},
			"bump-dep": {
				description: "bump a dependency and commit",
				args: ["pkg", "old", "new"],
				run: cmdBumpDep,
			},
			"bump-action": {
				description: "bump a GitHub Action ref and commit",
				args: ["action-ref", "from", "to"],
				run: cmdBumpAction,
			},
			commit: {
				description: "stage files and create a conventional commit",
				args: ["type", "scope", "msg"],
				run: cmdCommit,
			},
			status: {
				description: "print git status, log, and diff --stat",
				run: () => cmdStatus(),
			},
			"reset-deps": {
				description: "reset to merge-base with main (pass --confirm)",
				run: cmdResetDeps,
			},
			"close-prs": {
				description: "close Dependabot PRs or Renovate MRs and log them",
				args: ["n..."],
				run: cmdClosePrs,
			},
			cooldown: {
				description:
					"check a target version is old enough (default 7 days); prints JSON verdict",
				args: ["pkg", "old", "new"],
				run: cmdCooldown,
			},
			"push-pr": {
				description:
					"push deps branch and open draft PR (body on stdin; --ready skips draft)",
				run: cmdPushPr,
			},
			"ready-when-green": {
				description:
					"wait for PR checks, then mark the PR ready; exit 0 ready, 1 failed, 2 timeout",
				args: ["pr"],
				run: cmdReadyWhenGreen,
			},
			summary: { description: "print run summary", run: () => cmdSummary() },
		},
	});
}

/** Dispatch explicitly supplied arguments without eager state or provider access. */
export async function main(argv: string[]): Promise<void> {
	await buildCommand().run(argv);
}

if (import.meta.main) await main(Bun.argv.slice(2));

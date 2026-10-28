import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BumpLevel = "major" | "minor" | "patch" | "none";
export type ReleaseMode = "release" | "skip" | "republish";
export type Commit = { subject: string; body: string };
export type Detection = {
	mode: ReleaseMode;
	version: string;
	previous_tag: string;
};

const REPO_URL = "https://github.com/detailedghost/dg-ai";
const RANK: Record<BumpLevel, number> = { none: 0, patch: 1, minor: 2, major: 3 };
const CONVENTIONAL = /^([a-z]+)(?:\([^)]*\))?(!)?: \S/;
const RELEASE_COMMIT = /^chore\(release\): cut \d+\.\d+\.\d+$/;
const VERSION_SOURCE = "pkg/skills-cli/package.json";

export const stampTargets = [
	"pkg/extension/package.json",
	"pkg/skills-cli/package.json",
	"pkg/dg-daemon/package.json",
	"pkg/dg-agent/package.json",
	".claude-plugin/plugin.json",
	"plugins/dg/.codex-plugin/plugin.json",
	"pkg/dg-agent/src/version.ts",
	"pkg/dg-daemon/src/server/status.ts",
	"bun.lock",
] as const;

const STAMP_PATTERNS: Record<(typeof stampTargets)[number], RegExp> = {
	"pkg/extension/package.json": /^([\t ]{1,2}"version":\s*")[^"]*(")/m,
	"pkg/skills-cli/package.json": /^([\t ]{1,2}"version":\s*")[^"]*(")/m,
	"pkg/dg-daemon/package.json": /^([\t ]{1,2}"version":\s*")[^"]*(")/m,
	"pkg/dg-agent/package.json": /^([\t ]{1,2}"version":\s*")[^"]*(")/m,
	".claude-plugin/plugin.json": /^([\t ]{1,2}"version":\s*")[^"]*(")/m,
	"plugins/dg/.codex-plugin/plugin.json": /^([\t ]{1,2}"version":\s*")[^"]*(")/m,
	"pkg/dg-agent/src/version.ts": /(DG_AGENT_PACKAGE_VERSION = ")[^"]*(")/,
	"pkg/dg-daemon/src/server/status.ts": /(DG_DAEMON_PACKAGE_VERSION = ")[^"]*(")/,
	"bun.lock":
		/("name": "@dg\/(?:skills-cli|dg-daemon|dg-agent|extension)",\s+"version": ")[^"]*(")/g,
};

export function classify(commit: Commit): BumpLevel {
	const match = CONVENTIONAL.exec(commit.subject);
	if (!match) return "none";
	if (match[2] || /^BREAKING[ -]CHANGE: /m.test(commit.body)) return "major";
	switch (match[1]) {
		case "feat":
			return "minor";
		case "fix":
		case "perf":
			return "patch";
		default:
			return "none";
	}
}

export function highestLevel(commits: readonly Commit[]): BumpLevel {
	return commits.reduce<BumpLevel>((top, commit) => {
		const level = classify(commit);
		return RANK[level] > RANK[top] ? level : top;
	}, "none");
}

export function bump(version: string, level: BumpLevel): string | null {
	const parts = version.split(".").map(Number);
	const [major = 0, minor = 0, patch = 0] = parts;
	switch (level) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
		case "none":
			return null;
	}
}

export function previousTag(base: string, tags: readonly string[]): string | null {
	for (const candidate of [`v${base}`, `skills-v${base}`]) {
		if (tags.includes(candidate)) return candidate;
	}
	return null;
}

export function isReleaseCommit(subject: string): boolean {
	return RELEASE_COMMIT.test(subject);
}

export type DetectInput = {
	event: "push" | "dispatch";
	bumpInput: BumpLevel | "auto";
	base: string;
	tags: readonly string[];
	headSubject: string;
	commits: readonly Commit[];
};

export function detect(input: DetectInput): Detection {
	const previous = previousTag(input.base, input.tags) ?? "";
	if (isReleaseCommit(input.headSubject)) {
		return {
			mode: input.event === "dispatch" ? "republish" : "skip",
			version: input.base,
			previous_tag: previous,
		};
	}
	const level =
		input.bumpInput === "auto" ? highestLevel(input.commits) : input.bumpInput;
	const next = bump(input.base, level);
	if (next === null) {
		return { mode: "skip", version: input.base, previous_tag: previous };
	}
	return { mode: "release", version: next, previous_tag: previous };
}

type NoteGroup = "Breaking" | "Features" | "Fixes";

function noteGroup(commit: Commit): NoteGroup | null {
	switch (classify(commit)) {
		case "major":
			return "Breaking";
		case "minor":
			return "Features";
		case "patch":
			return "Fixes";
		case "none":
			return null;
	}
}

function noteLine(subject: string): string {
	const match = /^(.*?) \(#(\d+)\)$/.exec(subject);
	if (!match) return `- ${subject}`;
	return `- ${match[1]} ([#${match[2]}](${REPO_URL}/pull/${match[2]}))`;
}

export function renderNotes(commits: readonly Commit[]): string {
	const groups: NoteGroup[] = ["Breaking", "Features", "Fixes"];
	const sections = groups.flatMap((group) => {
		const lines = commits
			.filter((commit) => noteGroup(commit) === group)
			.map((commit) => noteLine(commit.subject));
		return lines.length ? [`### ${group}\n\n${lines.join("\n")}`] : [];
	});
	return `${sections.join("\n\n")}\n`;
}

export function prependChangelog(
	existing: string | null,
	version: string,
	date: string,
	notes: string,
): string {
	const entry = `## v${version} (${date})\n\n${notes.trim()}\n`;
	const header = "# Changelog\n\n";
	if (existing === null) return `${header}${entry}`;
	const body = existing.startsWith("# Changelog")
		? existing.replace(/^# Changelog\n+/, "")
		: existing;
	return `${header}${entry}\n${body}`;
}

export function stampText(
	target: (typeof stampTargets)[number],
	text: string,
	version: string,
): string {
	const pattern = STAMP_PATTERNS[target];
	if (!pattern.test(text)) throw new Error(`no version found in ${target}`);
	pattern.lastIndex = 0;
	return text.replace(pattern, `$1${version}$2`);
}

export function stamp(root: string, version: string): void {
	for (const target of stampTargets) {
		const path = join(root, target);
		writeFileSync(path, stampText(target, readFileSync(path, "utf8"), version));
	}
}

function git(root: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: root });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

function readCommits(root: string, range: string): Commit[] {
	const raw = git(root, ["log", "--format=%s%x1f%b%x1e", range]);
	return raw
		.split("\x1e")
		.map((record) => record.replace(/^\n/, ""))
		.filter((record) => record.length > 0)
		.map((record) => {
			const [subject = "", body = ""] = record.split("\x1f");
			return { subject, body };
		});
}

function readBase(root: string): string {
	const pkg = JSON.parse(readFileSync(join(root, VERSION_SOURCE), "utf8"));
	return String(pkg.version);
}

function listTags(root: string): string[] {
	return git(root, ["tag", "--list"]).split("\n").filter(Boolean);
}

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
}

function parseBump(value: string | undefined): BumpLevel | "auto" {
	if (value === undefined || value === "" || value === "auto") return "auto";
	if (value === "patch" || value === "minor" || value === "major") return value;
	throw new Error(`invalid --bump: ${value}`);
}

function notesSince(root: string, from: string | undefined): string {
	const base = from ?? previousTag(readBase(root), listTags(root));
	if (!base) throw new Error("no previous release tag found; pass --from");
	return renderNotes(readCommits(root, `${base}..HEAD`));
}

function runDetect(root: string, args: string[]): void {
	const event = flag(args, "event") === "dispatch" ? "dispatch" : "push";
	const base = readBase(root);
	const tags = listTags(root);
	const previous = previousTag(base, tags);
	const commits = previous ? readCommits(root, `${previous}..HEAD`) : [];
	if (!previous) throw new Error(`no v${base} or skills-v${base} tag found`);
	const result = detect({
		event,
		bumpInput: parseBump(flag(args, "bump")),
		base,
		tags,
		headSubject: git(root, ["log", "-1", "--format=%s"]).trim(),
		commits,
	});
	for (const [key, value] of Object.entries(result)) console.log(`${key}=${value}`);
}

export function main(argv: string[], root = process.cwd()): void {
	const [command, ...args] = argv;
	switch (command) {
		case "detect":
			return runDetect(root, args);
		case "stamp": {
			const version = flag(args, "version");
			if (!version) throw new Error("stamp requires --version");
			return stamp(root, version);
		}
		case "notes":
			process.stdout.write(notesSince(root, flag(args, "from")));
			return;
		case "changelog": {
			const version = flag(args, "version");
			if (!version) throw new Error("changelog requires --version");
			const date = flag(args, "date") ?? new Date().toISOString().slice(0, 10);
			const path = join(root, "CHANGELOG.md");
			const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
			const notes = notesSince(root, flag(args, "from"));
			writeFileSync(path, prependChangelog(existing, version, date, notes));
			return;
		}
		default:
			throw new Error(
				"usage: release-version.ts detect|stamp|notes|changelog [--event push|dispatch] [--bump auto|patch|minor|major] [--version X.Y.Z] [--from TAG] [--date YYYY-MM-DD]",
			);
	}
}

if (import.meta.main) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

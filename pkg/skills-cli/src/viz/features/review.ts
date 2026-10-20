import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { runShell, ShellError } from "../../utils/git";
import { scanAndCacheSubagents } from "../agents";
import { astroDir, sessionDir, sessionUrl, vizConfig } from "../config";
import { die, note } from "../io";
import { mintBoardSecurity } from "../respond-core";
import { ensureServer, openUrlOnce } from "../server";
import {
	clearStale,
	detectSessionId,
	markAwaitingVerdict,
	namespaceSlug,
} from "../session";

interface ReviewCommit {
	sha: string;
	subject: string;
}

interface ReviewFile {
	path: string;
	dir: string;
	status: string;
	additions: number;
	deletions: number;
	patch: string;
	slice: string | null;
	commitSha: string | null;
	newContent?: string;
}

interface SeedCommentInput {
	file: string;
	side?: "old" | "new";
	lineNumber?: number | null;
	startLineNumber?: number;
	body: string;
}

interface SeedComment {
	file: string;
	side: "old" | "new" | null;
	lineNumber: number | null;
	startLineNumber?: number;
	scope: "line" | "file";
	body: string;
}

function loadSeedComments(path: string): SeedComment[] {
	if (!existsSync(path)) die(`comments file not found: ${path}`);
	const raw = JSON.parse(readFileSync(path, "utf-8"));
	if (!Array.isArray(raw)) die(`comments file must be a JSON array: ${path}`);
	return (raw as SeedCommentInput[]).map((c, i) => {
		if (!c.file || !c.body)
			die(`comments[${i}] needs "file" and "body": ${path}`);
		const hasLine = c.lineNumber !== undefined && c.lineNumber !== null;
		return {
			file: c.file,
			side: hasLine ? (c.side ?? "new") : null,
			lineNumber: hasLine ? (c.lineNumber as number) : null,
			startLineNumber: c.startLineNumber,
			scope: hasLine ? "line" : "file",
			body: c.body,
		};
	});
}

function groupDir(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 2) return parts.slice(0, -1).join("/") || ".";
	return parts.slice(0, 2).join("/");
}

async function git(repo: string, args: string[]): Promise<string> {
	try {
		return (await runShell("git", ["-C", repo, ...args])).text();
	} catch (err) {
		const detail =
			err instanceof ShellError
				? err.stderr.toString()
				: err instanceof Error
					? err.message
					: "unknown error";
		die(`git ${args.join(" ")} failed: ${detail}`);
	}
}

async function parseCommits(
	repo: string,
	base: string,
	head: string,
): Promise<ReviewCommit[]> {
	const out = await git(repo, [
		"log",
		"--reverse",
		`--format=%h|%s`,
		`${base}..${head}`,
	]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const idx = line.indexOf("|");
			return { sha: line.slice(0, idx), subject: line.slice(idx + 1) };
		});
}

const SHA_LIKE = /^[0-9a-f]{7,40}$/i;

async function describeHead(
	repo: string,
	headRef: string,
	sha: string,
	commits: ReviewCommit[],
): Promise<string> {
	if (headRef && headRef !== "HEAD" && !SHA_LIKE.test(headRef)) return headRef;
	const branch = (
		await git(repo, [
			"for-each-ref",
			"--points-at",
			sha,
			"--format=%(refname:short)",
			"refs/heads/",
		])
	)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)[0];
	if (branch) return branch;
	const subject = commits.at(-1)?.subject.trim();
	if (subject)
		return subject.length > 72 ? `${subject.slice(0, 71)}…` : subject;
	return sha.slice(0, 8);
}

async function parseNumstat(
	repo: string,
	base: string,
	head: string,
): Promise<Map<string, { additions: number; deletions: number }>> {
	const out = await git(repo, ["diff", "--numstat", `${base}..${head}`]);
	const map = new Map<string, { additions: number; deletions: number }>();
	for (const line of out.split("\n").filter(Boolean)) {
		const [add, del, path] = line.split("\t");
		map.set(path, {
			additions: add === "-" ? 0 : Number(add),
			deletions: del === "-" ? 0 : Number(del),
		});
	}
	return map;
}

async function parseNameStatus(
	repo: string,
	base: string,
	head: string,
): Promise<Map<string, string>> {
	const out = await git(repo, ["diff", "--name-status", `${base}..${head}`]);
	const map = new Map<string, string>();
	for (const line of out.split("\n").filter(Boolean)) {
		const [status, ...rest] = line.split("\t");
		map.set(rest[rest.length - 1], status[0]);
	}
	return map;
}

async function parseFileCommits(
	repo: string,
	base: string,
	head: string,
): Promise<Map<string, string>> {
	const out = await git(repo, [
		"log",
		"--reverse",
		"--name-only",
		"--format=@@%h",
		`${base}..${head}`,
	]);
	const map = new Map<string, string>();
	let currentSha: string | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("@@")) {
			currentSha = line.slice(2);
		} else if (line.trim() && currentSha) {
			map.set(line, currentSha);
		}
	}
	return map;
}

function splitPatchByFile(fullPatch: string): Map<string, string> {
	const map = new Map<string, string>();
	const lines = fullPatch.split("\n");
	let current: string[] = [];
	let currentPath: string | null = null;
	const flush = () => {
		if (currentPath) map.set(currentPath, current.join("\n"));
	};
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			flush();
			current = [line];
			const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			currentPath = match ? match[2] : null;
		} else {
			current.push(line);
		}
	}
	flush();
	return map;
}

interface SpecSlice {
	id: number | string;
	name: string;
	files: string[];
	description?: string;
}

function plainProse(text: string): string {
	return text
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

function isStatusLine(text: string): boolean {
	return /^(mini ?qa|qa|verified|all \w+ ratified|human directive|added after|status)\b/i.test(
		text,
	);
}

function collectBlocks(lines: string[], start: number, end: number): string[] {
	const blocks: string[] = [];
	let current = "";
	const flush = () => {
		if (current) blocks.push(current);
		current = "";
	};
	for (let j = start; j < end; j++) {
		const line = lines[j].trim();
		if (line === "" || /^#{3,6}\s/.test(line)) {
			flush();
			continue;
		}
		if (/^[-*]\s/.test(line)) flush();
		current = current ? `${current} ${line}` : line;
	}
	flush();
	return blocks;
}

function parseSliceDescriptions(specText: string): Map<string, string> {
	const fromSection = new Map<string, string>();
	const fromSummary = new Map<string, string>();
	const lines = specText.split("\n");
	const headingRe = /^#{2,4}\s+Slice\s+([\d.]+)\s*(?:—|-)/;
	let inSummaries = false;

	for (let i = 0; i < lines.length; i++) {
		if (/^##\s+Slice Summaries\s*$/.test(lines[i])) {
			inSummaries = true;
			continue;
		}
		const m = lines[i].match(headingRe);
		if (!m) continue;
		const id = m[1];
		const target = inSummaries ? fromSummary : fromSection;
		if (target.has(id)) continue;

		let sectionEnd = Math.min(lines.length, i + 40);
		for (let j = i + 1; j < sectionEnd; j++) {
			if (/^#{2,4}\s+Slice\s/.test(lines[j])) {
				sectionEnd = j;
				break;
			}
		}

		for (const block of collectBlocks(lines, i + 1, sectionEnd)) {
			const text = plainProse(
				block.replace(/^-\s*\[[ xX]\]\s*/, "").replace(/^[-*]\s+/, ""),
			);
			if (!text || isStatusLine(text)) continue;
			const sentence = text.split(/(?<=[.!?])\s+/)[0] ?? text;
			if (sentence.length < 25) continue;
			target.set(
				id,
				sentence.length > 220 ? `${sentence.slice(0, 217)}…` : sentence,
			);
			break;
		}
	}

	for (const [id, text] of fromSummary)
		if (!fromSection.has(id)) fromSection.set(id, text);
	return fromSection;
}

function parseSpecSlices(specPath: string): SpecSlice[] {
	if (!existsSync(specPath)) die(`spec file not found: ${specPath}`);
	const text = readFileSync(specPath, "utf-8").replace(/\r\n/g, "\n");
	const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) die(`no YAML frontmatter found in ${specPath}`);
	const fm = fmMatch[1];
	const lines = fm.split("\n");

	const slicesStart = lines.findIndex((l) => /^slices:\s*$/.test(l));
	if (slicesStart === -1) return [];

	const slices: SpecSlice[] = [];
	let current: SpecSlice | null = null;
	let inFiles = false;

	for (let i = slicesStart + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^\S/.test(line)) break;

		const idMatch = line.match(/^\s{2}-\s*id:\s*(\S+)/);
		if (idMatch) {
			if (current) slices.push(current);
			current = {
				id: /^\d+$/.test(idMatch[1]) ? Number(idMatch[1]) : idMatch[1],
				name: "",
				files: [],
			};
			inFiles = false;
			continue;
		}
		if (!current) continue;

		const nameMatch = line.match(/^\s{4}name:\s*"?(.*?)"?\s*$/);
		if (nameMatch) {
			current.name = nameMatch[1];
			continue;
		}
		const inlineFiles = line.match(/^\s{4}files:\s*(\[.*\])\s*$/);
		if (inlineFiles) {
			try {
				const parsed = JSON.parse(inlineFiles[1]) as unknown;
				if (Array.isArray(parsed)) current.files.push(...parsed.map(String));
			} catch {
				current.files.push(
					...inlineFiles[1]
						.slice(1, -1)
						.split(",")
						.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
						.filter(Boolean),
				);
			}
			inFiles = false;
			continue;
		}
		if (/^\s{4}files:\s*$/.test(line)) {
			inFiles = true;
			continue;
		}
		if (inFiles) {
			const fileMatch = line.match(/^\s{6}-\s*(.+)$/);
			if (fileMatch) {
				current.files.push(fileMatch[1].trim().replace(/^['"]|['"]$/g, ""));
				continue;
			}
			inFiles = false;
		}
	}
	if (current) slices.push(current);

	const bodyDescriptions = parseSliceDescriptions(text);
	for (const slice of slices) {
		if (!slice.description)
			slice.description = bodyDescriptions.get(String(slice.id));
	}
	return slices;
}

interface DemoPayload {
	video?: string;
	poster?: string;
	caption?: string;
	screenshots?: { src: string; label?: string }[];
}

const VIDEO_RE = /\.(mp4|webm)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

function humanizeShotLabel(file: string): string {
	return file
		.replace(IMAGE_RE, "")
		.replace(/^\d+[-_]/, "")
		.replace(/[-_]+/g, " ")
		.trim();
}

function stageDemoAssets(
	demoPath: string,
	slug: string,
	caption: string,
): DemoPayload | null {
	if (!existsSync(demoPath)) die(`--demo path not found: ${demoPath}`);
	if (!statSync(demoPath).isDirectory())
		die(`--demo must be a directory of assets: ${demoPath}`);

	const entries = readdirSync(demoPath).filter((name) => {
		if (!SAFE_NAME_RE.test(name)) return false;
		return statSync(`${demoPath}/${name}`).isFile();
	});
	const video = entries.find((name) => VIDEO_RE.test(name));
	const poster = entries.find(
		(name) => IMAGE_RE.test(name) && /^poster\./i.test(name),
	);
	const shots = entries
		.filter((name) => IMAGE_RE.test(name) && name !== poster)
		.sort();

	if (!video && shots.length === 0) {
		note(
			`--demo: no video or image files in ${demoPath} — demo section omitted`,
		);
		return null;
	}

	const destDir = `${astroDir()}/public/demo-assets/${slug}`;
	rmSync(destDir, { recursive: true, force: true });
	mkdirSync(destDir, { recursive: true });
	for (const name of [video, poster, ...shots].filter(Boolean) as string[]) {
		copyFileSync(`${demoPath}/${name}`, `${destDir}/${name}`);
	}

	const base = `/demo-assets/${slug}`;
	return {
		...(video ? { video: `${base}/${video}` } : {}),
		...(poster ? { poster: `${base}/${poster}` } : {}),
		...(caption ? { caption } : {}),
		...(shots.length
			? {
					screenshots: shots.map((name) => ({
						src: `${base}/${name}`,
						label: humanizeShotLabel(name),
					})),
				}
			: {}),
	};
}

interface SliceMeta {
	id: string;
	name: string;
	label: string;
	description?: string;
	files: string[];
}

function sliceLabelFor(slice: SpecSlice): string {
	return slice.name ? `${slice.id} — ${slice.name}` : String(slice.id);
}

function buildSliceLookup(slices: SpecSlice[]): Map<string, string> {
	const lookup = new Map<string, string>();
	for (const slice of slices) {
		for (const file of slice.files) lookup.set(file, sliceLabelFor(slice));
	}
	return lookup;
}

export async function cmdReview(args: string[]): Promise<void> {
	let repo = "";
	let base = "";
	let head = "";
	let specPath = "";
	let commentsPath = "";
	let demoPath = "";
	let demoCaption = "";
	let noOpen = false;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--demo":
				demoPath = args[++i] ?? die("--demo requires a value");
				break;
			case "--demo-caption":
				demoCaption = args[++i] ?? die("--demo-caption requires a value");
				break;
			case "--repo":
				repo = args[++i] ?? die("--repo requires a value");
				break;
			case "--base":
				base = args[++i] ?? die("--base requires a value");
				break;
			case "--head":
				head = args[++i] ?? die("--head requires a value");
				break;
			case "--spec":
				specPath = args[++i] ?? die("--spec requires a value");
				break;
			case "--comments":
				commentsPath = args[++i] ?? die("--comments requires a value");
				break;
			case "--no-open":
				noOpen = true;
				break;
			default:
				die(`unknown argument: ${args[i]}`);
		}
	}

	if (!repo)
		die(
			"usage: dg-skills viz review --repo <path> --base <ref> --head <ref> [--spec <specfile>] [--comments <file.json>] [--demo <assets-dir>] [--demo-caption <text>] [--no-open]",
		);
	if (!base) die("--base is required");
	if (!head) die("--head is required");
	if (!existsSync(repo)) die(`repo not found: ${repo}`);

	const headRef = head;
	head = (await git(repo, ["rev-parse", head])).trim();

	const [commits, numstat, nameStatus, fileCommits, fullPatch] =
		await Promise.all([
			parseCommits(repo, base, head),
			parseNumstat(repo, base, head),
			parseNameStatus(repo, base, head),
			parseFileCommits(repo, base, head),
			git(repo, ["diff", `${base}..${head}`]),
		]);
	const patchByFile = splitPatchByFile(fullPatch);

	const specSlices = specPath ? parseSpecSlices(specPath) : [];
	const sliceLookup = buildSliceLookup(specSlices);
	const sliceMeta: SliceMeta[] = specSlices.map((s) => ({
		id: String(s.id),
		name: s.name,
		label: sliceLabelFor(s),
		...(s.description ? { description: s.description } : {}),
		files: s.files,
	}));

	const STATUS_LABEL: Record<string, string> = {
		A: "added",
		M: "modified",
		D: "deleted",
		R: "renamed",
		C: "copied",
	};

	const files: ReviewFile[] = Array.from(nameStatus.keys())
		.sort()
		.map((path) => {
			const stat = numstat.get(path) ?? { additions: 0, deletions: 0 };
			const statusCode = nameStatus.get(path) ?? "M";
			return {
				path,
				dir: groupDir(path),
				status: STATUS_LABEL[statusCode] ?? statusCode,
				additions: stat.additions,
				deletions: stat.deletions,
				patch: patchByFile.get(path) ?? "",
				slice: sliceLookup.get(path) ?? (specPath ? "other" : null),
				commitSha: fileCommits.get(path) ?? null,
			};
		});

	for (const f of files) {
		if (
			f.status !== "deleted" &&
			/\.(md|markdown|mdx|html|htm)$/i.test(f.path)
		) {
			try {
				f.newContent = await git(repo, ["show", `${head}:${f.path}`]);
			} catch {}
		}
	}

	const seedComments = commentsPath ? loadSeedComments(commentsPath) : [];

	const repoName = repo.replace(/\/$/, "").split("/").pop() ?? "repo";
	const rawSlug = `review-${repoName}-${head.replace(/[^A-Za-z0-9]+/g, "-")}`
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const headLabel = await describeHead(repo, headRef, head, commits);

	const payload = {
		template: "review",
		slug: rawSlug,
		title: `Code Review: ${headLabel}`,
		subtitle: `${base}..${head.slice(0, 8)} in ${repoName}`,
		date: new Date().toISOString().slice(0, 10),
		review: {
			repo,
			base,
			head,
			commits,
			files,
			...(sliceMeta.length ? { slices: sliceMeta } : {}),
			...(seedComments.length ? { seedComments } : {}),
		},
		subagents: scanAndCacheSubagents(repo),
		_secured: true,
	};

	const sid = detectSessionId();
	if (sid) (payload as { session_id?: string }).session_id = sid;

	const finalSlug = namespaceSlug(rawSlug, sid);
	(payload as { slug: string }).slug = finalSlug;

	if (demoPath) {
		const demo = stageDemoAssets(demoPath, finalSlug, demoCaption);
		if (demo) (payload as { demo?: DemoPayload }).demo = demo;
	}

	const serialized = JSON.stringify(payload, null, "\t");
	const slugDir = sessionDir(finalSlug);
	mkdirSync(slugDir, { recursive: true });
	chmodSync(slugDir, 0o700);
	writeFileSync(`${slugDir}/payload.json`, serialized);
	clearStale(finalSlug);
	markAwaitingVerdict(finalSlug);

	mintBoardSecurity(slugDir, vizConfig().vizDir);

	await ensureServer();
	const url = sessionUrl(finalSlug);
	if (!noOpen) openUrlOnce(finalSlug, url);
	process.stdout.write(`VIZ_URL=${url}\nVIZ_PATH=${slugDir}/payload.json\n`);
	note(url);
}

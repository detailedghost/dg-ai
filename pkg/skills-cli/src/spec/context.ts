import { dirname } from "node:path";
import { isRecord } from "@dg/common";
import { writeFileAtomic } from "@dg/common/node";
import { stringify } from "yaml";
import {
	frontmatterOf,
	nestedScalar,
	parseYaml,
	scalarField,
} from "./frontmatter";
import { git, repoToplevel } from "./git";
import { openIssueCount } from "./sections";
import {
	abspath,
	awkEquals,
	die,
	flagValue,
	isDirectory,
	isFile,
	jqLength,
	needFile,
	readText,
	records,
	say,
	stripNewlines,
	truthy,
	usageError,
} from "./shared";

interface ContextAux {
	specAbs: string;
	pathsFile: string;
	schoolDir: string;
}

async function contextAux(spec: string): Promise<ContextAux> {
	const specAbs = abspath(spec);
	const root = await repoToplevel(dirname(specAbs));
	const aux: ContextAux = { specAbs, pathsFile: "", schoolDir: "" };
	if (root === null) return aux;
	if (isFile(`${root}/.agents/paths.md`))
		aux.pathsFile = `${root}/.agents/paths.md`;
	if (isDirectory(`${root}/.agents/school`))
		aux.schoolDir = `${root}/.agents/school`;
	return aux;
}

function inferSchoolTopics(text: string): string[] {
	const topics: string[] = [];
	if (/(security|auth|secret|cwe|owasp)/i.test(text)) topics.push("security");
	if (/(perf|latency|throughput|n\+1)/i.test(text)) topics.push("performance");
	if (/(deploy|docker|ci\/cd|pipeline)/i.test(text))
		topics.push("infrastructure");
	return [...topics, "engineering", "quality", "tooling"];
}

async function contextSection(title: string, path: string): Promise<string> {
	return `\n## === ${title} ===\n\n${await Bun.file(path).text()}`;
}

async function flatContext(spec: string, school: string): Promise<string> {
	const aux = await contextAux(spec);
	const specText = await readText(spec);
	const topics =
		school === "" && aux.schoolDir !== ""
			? inferSchoolTopics(specText)
			: school.split(",");
	let out = `## === SPEC: ${aux.specAbs} ===\n\n${specText}`;
	if (aux.pathsFile !== "")
		out += await contextSection("paths.md", aux.pathsFile);
	if (aux.schoolDir === "") return out;
	for (const topic of topics) {
		const file = `${aux.schoolDir}/${topic}.md`;
		if (topic !== "" && isFile(file))
			out += await contextSection(`school/${topic}.md`, file);
	}
	return out;
}

async function leanContext(plan: string): Promise<string> {
	const aux = await contextAux(plan);
	const lines = records(await readText(plan));
	let out = "";
	if (aux.pathsFile !== "")
		out += await contextSection("paths.md", aux.pathsFile);
	if (aux.schoolDir !== "") {
		out += "\n## === school pointers ===\n\n";
		for (const topic of inferSchoolTopics(lines.join("\n"))) {
			const file = `${aux.schoolDir}/${topic}.md`;
			if (isFile(file)) out += `- ${file}\n`;
		}
	}
	const summary: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (line.startsWith("## Slice Summaries")) {
			inSection = true;
			summary.push(line);
		} else if (inSection && line.startsWith("## ")) break;
		else if (inSection) summary.push(line);
	}
	const body = stripNewlines(summary.map((line) => `${line}\n`).join(""));
	return body === "" ? out : `${out}\n${body}\n`;
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function projectSlice(value: unknown): Record<string, unknown> {
	const slice = record(value);
	const agents = record(slice.agents);
	const projected: Record<string, unknown> = {
		id: slice.id ?? null,
		name: slice.name ?? null,
		depends_on: slice.depends_on ?? null,
		files: slice.files ?? null,
		agents: {
			primary: agents.primary ?? null,
			...(truthy(agents.effort) ? { effort: agents.effort } : {}),
			...(truthy(agents.proxy) ? { proxy: agents.proxy } : {}),
			...(jqLength(agents.proxy_skills ?? []) > 0
				? { proxy_skills: agents.proxy_skills }
				: {}),
			...(jqLength(agents.qa ?? []) > 0 ? { qa: agents.qa } : {}),
		},
	};
	if (truthy(slice.prototype)) {
		const prototype = record(slice.prototype);
		projected.prototype = {
			path: prototype.path ?? null,
			variant: prototype.variant ?? null,
		};
	}
	return projected;
}

async function bundleContext(args: string[]): Promise<number> {
	const [bundle = "", ...flags] = args;
	let json = false;
	for (const flag of flags) {
		if (flag === "--json") json = true;
		else die(`unknown context flag: ${flag}`);
	}
	const plan = `${bundle}/plan.md`;
	needFile(plan);
	const bundleAbs = abspath(bundle);
	const planAbs = `${bundleAbs}/plan.md`;
	const front = frontmatterOf(await readText(plan));
	if (front === "") die(`no frontmatter in ${plan}`);
	const parsed = parseYaml(front);
	if (!parsed.ok) die(`frontmatter is not valid YAML: ${plan}`);
	const data = record(parsed.value);
	const slices = Array.isArray(data.slices) ? data.slices : [];
	const projection = {
		feature: data.feature ?? null,
		feature_snake_case: data.feature_snake_case ?? null,
		date: data.date ?? null,
		version: data.version ?? null,
		status: data.status ?? null,
		current_slice: data.current_slice ?? null,
		pr_strategy: data.pr_strategy ?? null,
		bundle: bundleAbs,
		plan_path: planAbs,
		slices: slices.map(projectSlice),
	};
	if (json) {
		say(`${JSON.stringify(projection, null, 2)}\n`);
		return 0;
	}
	const target = `${bundleAbs}/context.md`;
	const contextFront = stringify(projection, {
		lineWidth: 0,
		defaultKeyType: "PLAIN",
		defaultStringType: "QUOTE_DOUBLE",
	});
	writeFileAtomic(
		target,
		`---\n${contextFront}---\n${await leanContext(plan)}`,
	);
	say(`${target}\n`);
	return 0;
}

export async function contextCommand(args: string[]): Promise<number> {
	if (args[0] !== undefined && isDirectory(args[0])) return bundleContext(args);
	const [spec, ...flags] = args;
	if (spec === undefined)
		return usageError("context <spec> [--school topics,...]");
	needFile(spec);
	let school = "";
	for (let i = 0; i < flags.length; ) {
		const flag = flags[i] as string;
		if (flag !== "--school") die(`unknown context flag: ${flag}`);
		school = flagValue(flags, i, flag);
		i += 2;
	}
	say(await flatContext(spec, school));
	return 0;
}

export async function briefCommand(args: string[]): Promise<number> {
	const [spec] = args;
	if (spec === undefined) return usageError("brief <spec>");
	needFile(spec);
	const specAbs = abspath(spec);
	const text = await readText(spec);
	const front = frontmatterOf(text);
	const status = scalarField(front, "status") || "unknown";
	const current = scalarField(front, "current_slice") || "n/a";
	const perms = nestedScalar(front, "permissions", "run_commands") || "unset";
	let lastCommit = "n/a";
	const root = await repoToplevel(dirname(specAbs));
	if (root !== null) {
		const log = await git(root, ["log", "-1", "--pretty=%h %s"]);
		if (log !== null && log.status === 0)
			lastCommit = stripNewlines(log.stdout) || lastCommit;
	}
	say(
		[
			`spec:         ${specAbs}`,
			`status:       ${status}`,
			`current_slice: ${current}`,
			`run_commands: ${perms}`,
			`open_issues:  ${openIssueCount(records(text))}`,
			`last_commit:  ${lastCommit}`,
			"",
		].join("\n"),
	);
	return 0;
}

function sliceEntries(front: string): Record<string, unknown>[] {
	const parsed = parseYaml(front);
	if (!parsed.ok || !isRecord(parsed.value)) return [];
	const slices = parsed.value.slices;
	return Array.isArray(slices) ? slices.filter(isRecord) : [];
}

function shellGlob(pattern: string): RegExp {
	let source = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i] as string;
		if (char === "*") source += ".*";
		else if (char === "?") source += ".";
		else if (char === "\\" && i + 1 < pattern.length) {
			i += 1;
			source += (pattern[i] as string).replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
		} else if (char === "[") {
			let start = i + 1;
			if (pattern[start] === "!" || pattern[start] === "^") start += 1;
			if (pattern[start] === "]") start += 1;
			const close = pattern.indexOf("]", start);
			if (close < 0) {
				source += "\\[";
				continue;
			}
			let body = pattern.slice(i + 1, close);
			const negate = body.startsWith("!") || body.startsWith("^");
			if (negate) body = body.slice(1);
			source += `[${negate ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
			i = close;
		} else source += char.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "s");
}

export async function diffBundleCommand(args: string[]): Promise<number> {
	const [spec, ...flags] = args;
	if (spec === undefined) return usageError("diff-bundle <spec> [--base main]");
	needFile(spec);
	let base = "main";
	for (let i = 0; i < flags.length; ) {
		const flag = flags[i] as string;
		if (flag !== "--base") die(`unknown diff-bundle flag: ${flag}`);
		base = flagValue(flags, i, flag);
		i += 2;
	}
	const root = await repoToplevel(dirname(abspath(spec)));
	if (root === null) die("not inside a git repo");
	const mergeBase = await git(root, ["merge-base", "HEAD", base]);
	if (mergeBase === null || mergeBase.status !== 0)
		die(`cannot find merge-base with ${base}`);
	const diff = await git(root, [
		"diff",
		"--name-only",
		"-z",
		`${stripNewlines(mergeBase.stdout)}..HEAD`,
	]);
	if (diff === null || diff.status !== 0) die(`git diff failed against ${base}`);
	const changed = diff.stdout
		.split("\0")
		.filter((name) => name !== "");
	if (changed.length === 0) {
		say(`(no changes vs ${base})\n`);
		return 0;
	}

	const globsBySlice = new Map<string, string[]>();
	for (const slice of sliceEntries(frontmatterOf(await readText(spec)))) {
		const files = Array.isArray(slice.files) ? slice.files : [];
		if (files.length === 0) continue;
		const id = String(slice.id);
		globsBySlice.set(id, [
			...(globsBySlice.get(id) ?? []),
			...files.map(String),
		]);
	}
	if (globsBySlice.size === 0) {
		say("## (unmapped) — no slices[].files declared in frontmatter\n");
		say(`${changed.join("\n")}\n`);
		return 0;
	}

	const mapped = new Set<string>();
	for (const [id, globs] of globsBySlice) {
		const patterns = globs.map((glob) => shellGlob(glob.replaceAll("**", "*")));
		const matched = changed.filter((file) =>
			patterns.some((pattern) => pattern.test(file)),
		);
		for (const file of matched) mapped.add(file);
		say(`## Slice ${id}\n`);
		say(
			matched.length > 0
				? matched.map((file) => `  ${file}\n`).join("")
				: "  (none)\n",
		);
	}
	const leftovers = changed.filter((file) => !mapped.has(file));
	say("## (unmapped)\n");
	say(
		leftovers.length > 0
			? leftovers.map((file) => `  ${file}\n`).join("")
			: "  (none)\n",
	);
	return leftovers.length > 0 ? 1 : 0;
}

export async function readyCommand(args: string[]): Promise<number> {
	if (args.length < 2) usageError("ready <spec> <slice>");
	const [spec = "", target = ""] = args;
	needFile(spec);
	const entry = sliceEntries(frontmatterOf(await readText(spec))).find(
		(slice) => slice.id !== undefined && awkEquals(String(slice.id), target),
	);
	const listed = (raw: unknown) => (Array.isArray(raw) ? raw : []);
	const deps = [
		...new Set(
			[...listed(entry?.depends_on), ...listed(entry?.dependsOn)].map(String),
		),
	];
	if (deps.length === 0) {
		say(`slice ${target} has no dependencies — ready\n`);
		return 0;
	}
	const root = await repoToplevel(dirname(abspath(spec)));
	if (root === null) die("not inside a git repo");
	const log = await git(root, ["log", "--pretty=%s"]);
	const subjects = log?.status === 0 ? log.stdout : "";
	const blocked = deps.filter((dep) => !subjects.includes(`slice-${dep}:`));
	if (blocked.length > 0) {
		say(
			`slice ${target} BLOCKED by uncommitted deps:${blocked.map((dep) => ` ${dep}`).join("")}\n`,
		);
		return 1;
	}
	say(`slice ${target} ready (deps: ${deps.join("\n")})\n`);
	return 0;
}

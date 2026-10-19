import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isRecord } from "@dg/common";
import { lintFile } from "./lint-waves";
import { nextBundleNnn, slugOrDie } from "./paths";
import {
	abspath,
	die,
	flagValue,
	jqLength,
	jqRaw,
	localDate,
	needFile,
	PROGRAM,
	readText,
	SpecError,
	say,
	stripNewlines,
	truthy,
	warn,
} from "./shared";

const REQUIRED_KEYS = ["feature", "slug", "purpose", "scope", "slices"];

const SCAFFOLD_USAGE = `usage: ${PROGRAM} scaffold --home <dir> --slug <slug> --from-json <file> [--allow-overlap]\n`;

function text(value: unknown): string {
	return stripNewlines(jqRaw(value));
}

function items(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function bullets(prefix: string, value: unknown): string {
	return items(value)
		.map(
			(item) => `${prefix}${typeof item === "string" ? item : jqRaw(item)}\n`,
		)
		.join("");
}

function compact(value: unknown): string {
	return JSON.stringify(truthy(value) ? value : []);
}

function sliceFrontmatter(slice: Record<string, unknown>): string {
	const proxy = truthy(slice.proxy) ? text(slice.proxy) : "";
	const skills = compact(slice.proxy_skills);
	let out = `  - id: ${text(slice.id)}\n    name: ${JSON.stringify(text(slice.name))}\n`;
	out += `    depends_on: ${compact(slice.depends_on)}\n    files: ${compact(slice.files)}\n`;
	if (proxy !== "" || skills !== "[]") {
		out += "    agents:\n";
		if (proxy !== "") out += `      proxy: ${proxy}\n`;
		if (skills !== "[]") out += `      proxy_skills: ${skills}\n`;
	}
	return out;
}

function sliceBody(slice: Record<string, unknown>): string {
	return [
		`### Slice ${text(slice.id)} — ${text(slice.name)}\n\n`,
		"#### Engineering\n",
		bullets("- [ ] ", slice.engineering),
		"\n#### Testing Criteria\n##### Contracts\n",
		bullets("- [ ] ", slice.testing),
		"\n#### Acceptance Criteria\n",
		bullets("- [ ] ", slice.acceptance),
		"\n",
	].join("");
}

function scopeBlock(scope: unknown): string {
	const record = isRecord(scope) ? scope : {};
	return `## Scope\n### Included\n${bullets("- ", record.included)}### Excluded\n${bullets("- ", record.excluded)}`;
}

async function lintBlob(blob: string, allowOverlap: boolean): Promise<void> {
	let status: number;
	let output = "";
	try {
		const report = await lintFile(blob);
		status = report.status;
		output = report.text;
	} catch (error) {
		if (!(error instanceof SpecError)) throw error;
		process.stderr.write(`${PROGRAM}: ${error.message}\n`);
		status = 2;
	}
	if (status === 0) return;
	process.stderr.write(`${stripNewlines(output)}\n`);
	if (status !== 1) die("lint-waves failed on the decision blob");
	if (!allowOverlap)
		die(
			"refusing to scaffold: same-layer slices overlap (fix depends_on, or pass --allow-overlap)",
		);
	warn("--allow-overlap set; scaffolding despite overlap");
}

export async function scaffoldCommand(args: string[]): Promise<number> {
	let home = "";
	let slug = "";
	let blobPath = "";
	let allowOverlap = false;
	for (let i = 0; i < args.length; ) {
		const arg = args[i] as string;
		if (arg === "--home") {
			home = flagValue(args, i, arg);
			i += 2;
		} else if (arg === "--slug") {
			slug = flagValue(args, i, arg);
			i += 2;
		} else if (arg === "--from-json") {
			blobPath = flagValue(args, i, arg);
			i += 2;
		} else if (arg === "--allow-overlap") {
			allowOverlap = true;
			i += 1;
		} else if (arg === "-h" || arg === "--help") {
			say(SCAFFOLD_USAGE);
			return 0;
		} else die(`unknown scaffold flag: ${arg}`);
	}
	if (home === "") die("scaffold requires --home <dir>");
	if (slug === "") die("scaffold requires --slug <slug>");
	if (blobPath === "") die("scaffold requires --from-json <file>");
	needFile(blobPath);

	const dirSlug = slugOrDie(slug);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readText(blobPath));
	} catch {
		parsed = undefined;
	}
	const blob = isRecord(parsed) ? parsed : {};
	for (const key of REQUIRED_KEYS)
		if (!Object.hasOwn(blob, key))
			die(`decision blob missing required key: ${key}`);
	if (!(jqLength(blob.slices) > 0))
		die("decision blob slices[] must be non-empty");
	await lintBlob(blobPath, allowOverlap);

	mkdirSync(home, { recursive: true });
	const bundle = `${home}/${nextBundleNnn(home)}_${dirSlug}`;
	if (existsSync(bundle)) die(`bundle already exists: ${bundle}`);
	mkdirSync(`${bundle}/roundtable`, { recursive: true });

	const feature = text(blob.feature);
	const purpose = text(blob.purpose);
	const featureSlug = slugOrDie(text(blob.slug));
	const slices = items(blob.slices).map((slice) =>
		isRecord(slice) ? slice : {},
	);
	const summary = `## Purpose\n${purpose}\n\n${scopeBlock(blob.scope)}`;

	writeFileSync(
		`${bundle}/plan.md`,
		[
			"---\n",
			`feature: ${JSON.stringify(feature)}\n`,
			`feature_snake_case: ${featureSlug}\n`,
			`date: "${localDate()}"\n`,
			'version: "1.0"\n',
			"status: draft\ncurrent_slice: 0\npr_strategy: single\nslices:\n",
			...slices.map(sliceFrontmatter),
			"---\n\n",
			`# ${feature}\n\n`,
			summary,
			"\n",
			...slices.map(sliceBody),
			"## Slice Summaries\n\n## Agent Notes\n\n## Issues Remediation\n",
		].join(""),
	);
	writeFileSync(
		`${bundle}/initial.md`,
		`# ${feature} — Initial Notes\n\n${summary}`,
	);
	for (const slice of slices)
		writeFileSync(
			`${bundle}/roundtable/slice-${text(slice.id)}.md`,
			`# Slice ${text(slice.id)} — ${text(slice.name)}\n\nPer-slice review findings (plan.md step 5).\n`,
		);
	say(`${abspath(bundle)}\n`);
	return 0;
}

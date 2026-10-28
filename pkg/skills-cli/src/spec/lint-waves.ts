import { isRecord } from "@dg/common";
import { frontmatterOf, parseYaml } from "./frontmatter";
import {
	awkNumber,
	awkSplit,
	die,
	jqText,
	needFile,
	PROGRAM,
	readText,
	say,
	usageError,
} from "./shared";

interface Entry {
	glob: string;
	note: string;
}

interface Generator {
	write: string;
	triggers: string[];
}

interface WaveRows {
	ids: string[];
	deps: Map<string, string>;
	files: Map<string, Entry[]>;
	generators: Generator[];
}

interface LintReport {
	status: 0 | 1;
	text: string;
}

const WILDCARD = /[*?{[]/;

function prefixOf(text: string): string {
	const at = text.search(WILDCARD);
	return at < 0 ? text : text.slice(0, at);
}

function suffixOf(text: string): string {
	let i = text.length;
	while (i > 0 && !"*?]}".includes(text[i - 1] as string)) i -= 1;
	return text.slice(i);
}

function compatible(left: string, right: string): boolean {
	if (left === "*" || right === "*") return true;
	if (!WILDCARD.test(left) && !WILDCARD.test(right)) return left === right;
	const leftPrefix = prefixOf(left);
	const rightPrefix = prefixOf(right);
	if (
		!leftPrefix.startsWith(rightPrefix) &&
		!rightPrefix.startsWith(leftPrefix)
	)
		return false;
	const leftSuffix = suffixOf(left);
	const rightSuffix = suffixOf(right);
	return leftSuffix.endsWith(rightSuffix) || rightSuffix.endsWith(leftSuffix);
}

function overlaps(left: string, right: string): boolean {
	const a = awkSplit(left.replace(/^\.\//, ""), "/");
	const b = awkSplit(right.replace(/^\.\//, ""), "/");
	const memo = new Map<number, boolean>();
	const match = (i: number, j: number): boolean => {
		const key = i * (b.length + 1) + j;
		const known = memo.get(key);
		if (known !== undefined) return known;
		let result: boolean;
		if (i >= a.length) result = b.slice(j).every((part) => part === "**");
		else if (j >= b.length) result = a.slice(i).every((part) => part === "**");
		else if (a[i] === "**") result = match(i + 1, j) || match(i, j + 1);
		else if (b[j] === "**") result = match(i, j + 1) || match(i + 1, j);
		else
			result =
				compatible(a[i] as string, b[j] as string) && match(i + 1, j + 1);
		memo.set(key, result);
		return result;
	};
	return match(0, 0);
}

function sharedLocation(left: string, right: string): string {
	if (left === right) return left;
	const a = awkSplit(left, "/");
	const b = awkSplit(right, "/");
	let shared = "";
	for (
		let k = 0;
		k < a.length &&
		k < b.length &&
		a[k] === b[k] &&
		!WILDCARD.test(a[k] as string);
		k += 1
	)
		shared += `${a[k]}/`;
	return shared === "" ? "(repository root)" : `under ${shared}`;
}

function addFile(rows: WaveRows, id: string, glob: string, note: string): void {
	const entries = rows.files.get(id) ?? [];
	if (!entries.some((entry) => entry.glob === glob))
		entries.push({ glob, note });
	rows.files.set(id, entries);
}

function listOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asList(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [value];
}

function rowsFromData(data: Record<string, unknown>): WaveRows {
	const rows: WaveRows = {
		ids: [],
		deps: new Map(),
		files: new Map(),
		generators: [],
	};
	for (const slice of listOf(data.slices).filter(isRecord)) {
		const id = jqText(slice.id);
		rows.ids.push(id);
		rows.deps.set(id, listOf(slice.depends_on).map(jqText).join(","));
	}
	for (const slice of listOf(data.slices).filter(isRecord))
		for (const glob of listOf(slice.files))
			addFile(rows, jqText(slice.id), jqText(glob), "");
	for (const item of listOf(data.serializing)) {
		const writes =
			typeof item === "string"
				? [item]
				: asList(isRecord(item) ? item.writes : []);
		const when =
			typeof item === "string"
				? [item]
				: asList(isRecord(item) ? (item.when ?? []) : []);
		for (const write of writes)
			rows.generators.push({
				write: jqText(write),
				triggers: when.map(jqText),
			});
	}
	return rows;
}

function layersOf(rows: WaveRows): Map<string, number> {
	const known = new Set(rows.ids);
	const done = new Map<string, number>();
	const visiting = new Set<string>();
	const layerOf = (id: string): number => {
		const cached = done.get(id);
		if (cached !== undefined) return cached;
		if (visiting.has(id)) die(`dependency cycle through slice ${id}`);
		visiting.add(id);
		let deepest = -1;
		for (const dep of awkSplit(rows.deps.get(id) ?? "", ",")) {
			if (dep === "") continue;
			if (!known.has(dep)) die(`slice ${id} depends on unknown slice ${dep}`);
			deepest = Math.max(deepest, layerOf(dep));
		}
		visiting.delete(id);
		done.set(id, deepest + 1);
		return deepest + 1;
	};
	const layers = new Map<string, number>();
	for (const id of rows.ids) layers.set(id, layerOf(id));
	return layers;
}

/** Dependency layer of every slice id in a parsed plan, as lint-waves computes it. */
export function sliceLayers(data: Record<string, unknown>): Map<string, number> {
	return layersOf(rowsFromData(data));
}

function lintRows(rows: WaveRows): LintReport {
	for (const id of rows.ids)
		for (const generator of rows.generators) {
			let hit = "";
			for (const trigger of generator.triggers) {
				if (hit !== "") break;
				if (trigger === "") continue;
				const original = (rows.files.get(id) ?? []).filter(
					(entry) => entry.note === "",
				);
				if (original.some((entry) => overlaps(entry.glob, trigger)))
					hit = trigger;
			}
			if (hit !== "")
				addFile(
					rows,
					id,
					generator.write,
					`generator output, triggered by ${hit}`,
				);
		}

	const layers = layersOf(rows);
	const maxLayer = Math.max(0, ...layers.values());

	const out: string[] = [];
	for (let layer = 0; layer <= maxLayer; layer += 1) {
		const members = rows.ids.filter((id) => layers.get(id) === layer);
		out.push(`layer ${layer}:${members.map((id) => ` ${id}`).join("")}\n`);
	}
	let bad = false;
	for (let x = 0; x < rows.ids.length; x += 1)
		for (let y = x + 1; y < rows.ids.length; y += 1) {
			const p = rows.ids[x] as string;
			const q = rows.ids[y] as string;
			if (layers.get(p) !== layers.get(q)) continue;
			let hits = 0;
			for (const left of rows.files.get(p) ?? [])
				for (const right of rows.files.get(q) ?? []) {
					if (!overlaps(left.glob, right.glob)) continue;
					if (hits === 0)
						out.push(
							`OVERLAP layer ${layers.get(p)}: slice ${p} <-> slice ${q}\n`,
						);
					hits += 1;
					const leftNote = left.note === "" ? "" : ` (${left.note})`;
					const rightNote = right.note === "" ? "" : ` (${right.note})`;
					out.push(
						`  ${left.glob}${leftNote} <-> ${right.glob}${rightNote}  [${sharedLocation(left.glob, right.glob)}]\n`,
					);
				}
			if (hits > 0) {
				bad = true;
				const ascending = awkNumber(p) < awkNumber(q);
				out.push(
					`  fix: add ${ascending ? p : q} to slice ${ascending ? q : p} depends_on\n`,
				);
			}
		}
	if (bad) {
		out.push(
			"FAIL: same-layer slices share files; serialize them with depends_on\n",
		);
		return { status: 1, text: out.join("") };
	}
	out.push("ok: no same-layer overlap\n");
	return { status: 0, text: out.join("") };
}

export async function lintFile(src: string): Promise<LintReport> {
	needFile(src);
	const text = await readText(src);
	const first = text.replace(/[ \t\r\n]/g, "").charAt(0);
	let data: unknown;
	if (first === "{") {
		try {
			data = JSON.parse(text);
		} catch {
			data = undefined;
		}
		if (!isRecord(data) || !Array.isArray(data.slices))
			die("blob has no slices[]");
	} else {
		const front = frontmatterOf(text);
		if (front === "") die(`no frontmatter block: ${src}`);
		const parsed = parseYaml(front);
		if (!parsed.ok) die(`frontmatter is not valid YAML: ${src}`);
		data = parsed.value;
		if (!isRecord(data) || !Array.isArray(data.slices))
			die("frontmatter has no slices[]");
	}
	return lintRows(rowsFromData(data as Record<string, unknown>));
}

export async function lintWavesCommand(args: string[]): Promise<number> {
	let src = "";
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			say(`usage: ${PROGRAM} lint-waves <plan.md | blob.json>\n`);
			return 0;
		}
		if (arg.startsWith("-")) die(`unknown lint-waves flag: ${arg}`);
		if (src !== "")
			die("lint-waves takes a single <plan.md | blob.json> argument");
		src = arg;
	}
	if (src === "") return usageError("lint-waves <plan.md | blob.json>");
	const report = await lintFile(src);
	say(report.text);
	return report.status;
}

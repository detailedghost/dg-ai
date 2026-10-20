import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "@dg/common/node";

const PREAMBLE = "# Checkpoints\n";
const ID_PATTERN = /^\d{4}-\d{2}-\d{2} \d{4} — .+ — .+$/;
const REQUIRED_SUBSECTIONS = [
	"Branches and PRs",
	"Done",
	"In progress",
	"Next steps",
	"Open questions",
	"Gotchas",
];
const LOCK_TRIES = 50;

export interface CheckpointSection {
	id: string;
	status: string;
	summary: string;
	text: string;
}

export function defaultCheckpointFile(): string {
	return path.join(process.env.HOME || homedir(), "doc", "checkpoint.md");
}

function metaLine(text: string, key: string): string {
	const match = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
	return match ? (match[1] ?? "").trim() : "";
}

function splitFile(content: string): { preamble: string; sections: string[] } {
	const lines = content.split("\n");
	const first = lines.findIndex((l) => l.startsWith("## "));
	if (first === -1) return { preamble: content, sections: [] };
	const sections: string[] = [];
	for (const line of lines.slice(first)) {
		if (line.startsWith("## ")) sections.push(`${line}\n`);
		else sections[sections.length - 1] += `${line}\n`;
	}
	return {
		preamble: lines.slice(0, first).join("\n"),
		sections: sections.map((s) => `${s.trimEnd()}\n`),
	};
}

function joinFile(preamble: string, sections: string[]): string {
	const head = preamble.trim() === "" ? PREAMBLE : `${preamble.trimEnd()}\n`;
	return sections.length === 0 ? head : `${head}\n${sections.join("\n")}`;
}

function toSection(text: string): CheckpointSection {
	return {
		id: (text.split("\n")[0] ?? "").slice(3).trim(),
		status: metaLine(text, "status") || "open",
		summary: metaLine(text, "summary"),
		text,
	};
}

/** Throws with a one-line fix when a section cannot resume a session. */
export function validateSection(body: string): CheckpointSection {
	const text = `${body.trim()}\n`;
	const lines = text.split("\n");
	const heading = lines[0] ?? "";
	if (!heading.startsWith("## "))
		throw new Error(
			'first line must be "## <YYYY-MM-DD HHMM> — <project> — <title>"',
		);
	const id = heading.slice(3).trim();
	if (!ID_PATTERN.test(id))
		throw new Error(
			`id "${id}" must match "YYYY-MM-DD HHMM — project — title"`,
		);
	if (lines.slice(1).some((l) => l.startsWith("## ")))
		throw new Error('one section per call; use "### " for sub-headings');
	if (!metaLine(text, "summary"))
		throw new Error('missing one-line "summary: ..." line');
	if (!metaLine(text, "repo")) throw new Error('missing "repo: <path>" line');
	for (const name of REQUIRED_SUBSECTIONS) {
		if (!lines.some((l) => l.trim() === `### ${name}`))
			throw new Error(`missing "### ${name}" sub-section`);
	}
	return toSection(text);
}

export function listSections(content: string): CheckpointSection[] {
	return splitFile(content).sections.map(toSection);
}

/** Exact id wins; otherwise every section whose text contains the query, case-insensitive. */
export function findSections(
	sections: CheckpointSection[],
	query: string,
): CheckpointSection[] {
	const exact = sections.filter((s) => s.id === query);
	if (exact.length > 0) return exact;
	const needle = query.toLowerCase();
	return sections.filter((s) => s.text.toLowerCase().includes(needle));
}

export function appendSection(
	content: string,
	section: CheckpointSection,
): string {
	const { preamble, sections } = splitFile(content);
	if (sections.some((s) => s.startsWith(`## ${section.id}\n`))) {
		throw new Error(`id "${section.id}" exists; pass --replace to update it`);
	}
	return joinFile(preamble, [...sections, section.text]);
}

export function replaceSection(
	content: string,
	section: CheckpointSection,
): string {
	const { preamble, sections } = splitFile(content);
	const at = sections.findIndex((s) => s.startsWith(`## ${section.id}\n`));
	if (at === -1)
		throw new Error(`no section with id "${section.id}" to replace`);
	return joinFile(
		preamble,
		sections.map((s, i) => (i === at ? section.text : s)),
	);
}

export class AmbiguousQueryError extends Error {
	constructor(
		readonly query: string,
		readonly hits: CheckpointSection[],
	) {
		super(`${hits.length} sections match "${query}"; rerun with the full id`);
	}
}

/** Drops the one section the query names; throws when none or several match. */
export function removeSection(
	content: string,
	query: string,
): {
	removed: CheckpointSection;
	content: string;
	leftover: "none" | "preamble" | "sections";
} {
	const { preamble, sections } = splitFile(content);
	const hits = findSections(sections.map(toSection), query);
	const removed = hits[0];
	if (!removed)
		throw new Error(`no checkpoint matches "${query}"; run kick-list`);
	if (hits.length > 1) throw new AmbiguousQueryError(query, hits);
	const rest = sections.filter((s) => s !== removed.text);
	const leftover =
		rest.length > 0
			? "sections"
			: preamble.trim() === PREAMBLE.trim()
				? "none"
				: "preamble";
	return { removed, content: joinFile(preamble, rest), leftover };
}

export function readCheckpointFile(file: string): string {
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

async function withLock<T>(file: string, fn: () => T): Promise<T> {
	const lock = `${file}.lock`;
	let held = false;
	for (let i = 0; i < LOCK_TRIES && !held; i++) {
		try {
			closeSync(openSync(lock, "wx"));
			held = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			await Bun.sleep(100);
		}
	}
	if (!held)
		throw new Error(
			`${lock} is held; remove it if no other session is writing`,
		);
	try {
		return fn();
	} finally {
		rmSync(lock, { force: true });
	}
}

/** Applies transform to the file under a lock; a null result deletes it. */
export async function updateCheckpointFile(
	file: string,
	transform: (content: string) => string | null,
): Promise<void> {
	mkdirSync(path.dirname(file), { recursive: true });
	await withLock(file, () => {
		const next = transform(readCheckpointFile(file));
		if (next === null) {
			rmSync(file, { force: true });
			return;
		}
		writeFileAtomic(
			file,
			next,
			existsSync(file) ? statSync(file).mode & 0o777 : undefined,
		);
	});
}

import { existsSync } from "node:fs";

export type ErdCandidateKind = "dir" | "file" | "db-table" | "module";

export interface ErdCandidate {
	id: string;
	kind: ErdCandidateKind;
	score: number;
	evidence: string;
}

/** Injectable dependency sources — passed as functions so tests use mocks with no live creds. */
export interface ErdResolveDeps {
	/** Token-overlap match of concept tokens against directory basenames (mcp__fff__find_files). */
	matchDirNames: (concept: string) => Promise<ErdCandidate[]>;
	/** Grep code for concept tokens (mcp__fff__grep); returns matched file candidates. */
	grepCode: (concept: string) => Promise<ErdCandidate[]>;
	/** Shell to `db tables`/`db describe` to match concept against live DB objects. */
	matchDbObjects: (concept: string) => Promise<ErdCandidate[]>;
}

export type ErdInputKind = "concrete" | "fuzzy";

export function detectErdInputKind(input: string): ErdInputKind {
	if (!input || /\s/.test(input)) {
		return "fuzzy";
	}
	return existsSync(input) ? "concrete" : "fuzzy";
}

/** Merges all three sources, keeping the highest score per id (first-seen wins ties); never throws. */
export async function resolveErdFuzzy(concept: string, deps: ErdResolveDeps): Promise<ErdCandidate[]> {
	const settled = await Promise.allSettled([
		deps.matchDirNames(concept),
		deps.grepCode(concept),
		deps.matchDbObjects(concept),
	]);

	const all: ErdCandidate[] = [];
	for (const result of settled) {
		if (result.status === "fulfilled") {
			all.push(...result.value);
		}
	}

	const finite = (s: number) => (Number.isFinite(s) ? s : -Infinity);

	const byId = new Map<string, ErdCandidate>();
	for (const c of all) {
		const existing = byId.get(c.id);
		if (!existing || finite(c.score) > finite(existing.score)) {
			byId.set(c.id, c);
		}
	}

	return [...byId.values()].sort((a, b) => finite(b.score) - finite(a.score));
}

async function defaultMatchDirNames(concept: string): Promise<ErdCandidate[]> {
	const tokens = concept
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (tokens.length === 0) {
		return [];
	}
	const { readdirSync, statSync } = await import("node:fs");
	const roots = [process.cwd(), ...(process.env.HOME ? [`${process.env.HOME}/code`] : [])];
	const candidates: ErdCandidate[] = [];
	for (const root of roots) {
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const basename = entry.toLowerCase();
			const hits = tokens.filter((t) => basename.includes(t)).length;
			if (hits > 0) {
				const entryPath = `${root}/${entry}`;
				let isDirectory: boolean;
				try {
					isDirectory = statSync(entryPath).isDirectory();
				} catch {
					continue;
				}
				const kind = isDirectory ? "dir" : "file";
				candidates.push({
					id: entryPath,
					kind,
					score: hits / tokens.length,
					evidence: kind === "dir" ? "matched directory basename" : "matched file basename",
				});
			}
		}
	}
	return candidates;
}

async function defaultGrepCode(_concept: string): Promise<ErdCandidate[]> {
	return [];
}

async function defaultMatchDbObjects(_concept: string): Promise<ErdCandidate[]> {
	return [];
}

/** Outside an agent session, only matchDirNames does real work; the other two return nothing. */
export const defaultErdResolveDeps: ErdResolveDeps = {
	matchDirNames: defaultMatchDirNames,
	grepCode: defaultGrepCode,
	matchDbObjects: defaultMatchDbObjects,
};

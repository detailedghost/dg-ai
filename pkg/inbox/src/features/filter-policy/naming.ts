import { parseSieve } from "./parse";

export type NamingPolicy = {
	folderSlugPattern: string;
	folderExceptions: string[];
};

export type RenameSuggestion = {
	to: string;
	reason: string;
};

const defaultSlugPattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

export function defaultNamingPolicy(): NamingPolicy {
	return {
		folderSlugPattern: defaultSlugPattern,
		folderExceptions: [],
	};
}

export function suggestFilterRename(
	name: string,
	context: { sieve?: string; folderPaths?: string[] } = {},
): RenameSuggestion | undefined {
	const reasons: string[] = [];
	let next = name.trim();
	const bot = /^bot\s+-\s+(.+)$/i.exec(next);
	if (bot?.[1]) {
		next = `+${capitalizeTag(bot[1])}`;
		reasons.push("Bot filters use a plus-tag name");
	}
	const plus = /^\+([A-Za-z0-9]+)(.*)$/.exec(next);
	if (plus?.[1] && plus[1] !== capitalizeTag(plus[1])) {
		next = `+${capitalizeTag(plus[1])}${plus[2] ?? ""}`;
		reasons.push("Plus-tags use a capital letter");
	}
	if (/\bNotif\b/.test(next) && !next.includes("Notification")) {
		next = next.replace(/\bNotif\b/g, "Notification");
		reasons.push("Notif expands to Notification");
	}
	const parsed = context.sieve ? parseSieve(context.sieve) : undefined;
	if (parsed) {
		for (const tag of parsed.plusTags) {
			if (!parsed.dotTags.includes(tag)) continue;
			const suffix = `& .${tag}`;
			if (next.toLowerCase().includes(suffix)) continue;
			const base = `+${capitalizeTag(tag)}`;
			if (next === base || next.toLowerCase() === `+${tag}`) {
				next = `${base} & .${tag}`;
				reasons.push("Dot-address shares this plus-tag");
			}
		}
	}
	const folderWords = folderWordsFrom(
		context.folderPaths ?? [],
		parsed?.fileinto ?? [],
	);
	const parts = next.split(" - ");
	const last = parts.at(-1) ?? "";
	const plural = pluralFolderWord(last, folderWords);
	if (plural && parts.length > 1) {
		parts[parts.length - 1] = plural;
		next = parts.join(" - ");
		reasons.push("Use the folder's plural");
	} else {
		const expanded = truncatedFolderWord(last, folderWords);
		if (expanded && parts.length > 1) {
			parts[parts.length - 1] = expanded;
			next = parts.join(" - ");
			reasons.push("Subname looks truncated");
		}
	}
	if (next === name.trim() || reasons.length === 0) return undefined;
	return { to: next, reason: reasons.join("; ") };
}

export function suggestFolderPath(
	path: string,
	policy: NamingPolicy,
): RenameSuggestion | undefined {
	const segments = splitPath(path);
	let changed = false;
	const next = segments.map((segment) => {
		if (segmentAllowed(segment, policy)) return segment;
		changed = true;
		const slug = segment
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		return slug || segment.toLowerCase();
	});
	if (!changed) return undefined;
	return {
		to: next.join("/"),
		reason:
			"Folder segments use the configured slug pattern unless listed as exceptions",
	};
}

export function segmentAllowed(segment: string, policy: NamingPolicy): boolean {
	if (policy.folderExceptions.includes(segment)) return true;
	return compilePattern(policy.folderSlugPattern).test(segment);
}

export function compilePattern(pattern: string): RegExp {
	try {
		return new RegExp(pattern);
	} catch {
		throw new Error(
			`Folder slug pattern is not a valid regular expression: ${pattern}`,
		);
	}
}

function folderWordsFrom(paths: string[], fileinto: string[]): string[] {
	return [...paths, ...fileinto].flatMap((path) => splitPath(path));
}

function pluralFolderWord(token: string, words: string[]): string | undefined {
	const stem = singular(token);
	if (stem.length < 4) return undefined;
	const match = words.find((word) => singular(word) === stem);
	if (!match) return undefined;
	const titled = capitalizeTag(match);
	if (titled.toLowerCase() === token.toLowerCase()) return undefined;
	return titled;
}

function truncatedFolderWord(
	token: string,
	words: string[],
): string | undefined {
	if (token.length < 3) return undefined;
	const lower = token.toLowerCase();
	const match = words.find((word) => {
		const candidate = word.toLowerCase();
		return (
			candidate.startsWith(lower) &&
			candidate.length > lower.length + 1 &&
			candidate !== `${lower}s`
		);
	});
	if (!match) return undefined;
	const titled = capitalizeTag(match);
	if (titled.toLowerCase() === lower) return undefined;
	return titled;
}

function singular(word: string): string {
	const lower = word.toLowerCase();
	return lower.endsWith("s") ? lower.slice(0, -1) : lower;
}

function capitalizeTag(value: string): string {
	const word = value.trim();
	if (!word) return word;
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function splitPath(path: string): string[] {
	return path
		.split("/")
		.map((segment) => segment.trim())
		.filter(Boolean);
}

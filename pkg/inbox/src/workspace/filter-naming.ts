import type { ProtonFilter, ProtonFolder } from "../protonmail/types";
import {
	folderDisplayName,
	folderPath,
	normalizeFolderSelector,
	resolveFolder,
} from "./folders";

export type FilterNamingConvention = {
	targetFolder: string;
	prefix: string;
	sourceFilterName: string;
	confidence: "high" | "medium";
	scope: "generic" | "specific";
	reason: string;
};

type InferredTarget = {
	targetFolder: string;
	confidence: "high" | "medium";
	reason: string;
};

export function inferFilterNamingConventions(
	filters: ProtonFilter[],
	folders: ProtonFolder[] = [],
): FilterNamingConvention[] {
	const conventions = new Map<string, FilterNamingConvention>();
	for (const filter of filters) {
		if (!filter.enabled || isGeneratedFilterName(filter.name)) {
			continue;
		}
		const inferred = inferFilterTarget(filter, folders);
		if (!inferred) {
			continue;
		}
		const convention: FilterNamingConvention = {
			targetFolder: inferred.targetFolder,
			prefix: filter.name,
			sourceFilterName: filter.name,
			confidence: inferred.confidence,
			scope: inferScope(filter.name, inferred.targetFolder),
			reason: inferred.reason,
		};
		const key = `${normalizeFolderSelector(convention.targetFolder)}\u0000${normalize(convention.prefix)}`;
		conventions.set(key, convention);
	}
	return [...conventions.values()].sort(sortConventions);
}

export function preferredFilterPrefix(
	conventions: FilterNamingConvention[],
	targetFolder: string,
	fallback: string,
): string {
	const target = normalizeFolderSelector(targetFolder);
	const matches = conventions
		.filter(
			(convention) =>
				normalizeFolderSelector(convention.targetFolder) === target &&
				convention.scope === "generic",
		)
		.sort(sortConventions);
	return matches[0]?.prefix ?? fallback;
}

export function isGeneratedFilterName(name: string): boolean {
	if (/^Email Organizer: .+ -> .+$/.test(name)) {
		return true;
	}
	return generatedNamePattern().test(name);
}

export function generatedNamePattern(): RegExp {
	return /^(?:.+) - [a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
}

function inferFilterTarget(
	filter: ProtonFilter,
	folders: ProtonFolder[],
): InferredTarget | undefined {
	const text = [filter.name, ...filter.conditions, ...filter.actions].join(
		"\n",
	);
	const fileinto = text.match(/\bfileinto\s+(?:"([^"]+)"|([^;\n]+))/i);
	const fileintoTarget = fileinto?.[1] ?? fileinto?.[2];
	if (fileintoTarget) {
		const folder = safeResolveFolder(folders, fileintoTarget);
		if (folder) {
			return {
				targetFolder: folderDisplayName(folder),
				confidence: "high",
				reason: "Existing filter action files into this folder.",
			};
		}
	}

	const nameText = normalize(filter.name);
	for (const folder of folders) {
		const displayName = folderDisplayName(folder);
		const values = [folder.name, folderPath(folder), displayName]
			.map(normalize)
			.filter(Boolean);
		if (values.some((value) => nameText.includes(value))) {
			return {
				targetFolder: displayName,
				confidence: "medium",
				reason: "Existing filter name or body mentions this folder.",
			};
		}
	}

	const alias = targetAlias(nameText);
	if (!alias) {
		return undefined;
	}
	const folder = safeResolveFolder(folders, alias.targetFolder);
	return {
		targetFolder: folder ? folderDisplayName(folder) : alias.targetFolder,
		confidence: "medium",
		reason: `Existing filter name matches the ${alias.targetFolder} folder policy.`,
	};
}

function targetAlias(text: string): { targetFolder: string } | undefined {
	const aliases: [RegExp, string][] = [
		[/\bcredit\s*cards?\b/, "credit-card"],
		[/\bpurchases?\b|\breceipts?\b/, "receipt"],
		[/\bbank(?:ing)?\b/, "bank"],
		[/\binvest(?:ment|ments|ing)?\b/, "investments"],
		[/\binvoices?\b|\bbilling\b/, "invoice"],
		[/\bcalendar\b|\bevents?\b/, "calendar"],
		[/\bchurch\b/, "church"],
		[/\bpets?\b/, "pet"],
		[/\bspam\b/, "Spam"],
		[/\bhunt\b/, "hunt"],
	];
	const match = aliases.find(([pattern]) => pattern.test(text));
	return match ? { targetFolder: match[1] } : undefined;
}

function inferScope(
	name: string,
	targetFolder: string,
): "generic" | "specific" {
	const text = normalize(name);
	const target = normalizeFolderSelector(targetFolder);
	if (
		text.startsWith("fin - ") ||
		text.startsWith("app - ") ||
		text === "investment" ||
		text === "+pet" ||
		text.includes("+church")
	) {
		return "generic";
	}
	const specificSignals = [
		"aws",
		"health",
		"job",
		"recruiter",
		"social",
		"education",
		"house",
		"home",
		"food",
		"work",
		"wedding",
		"family",
		"lifestyles",
		"thundermane",
		"robinhood",
	];
	if (specificSignals.some((signal) => text.includes(signal))) {
		return "specific";
	}
	if (text.startsWith("+")) {
		return "generic";
	}
	if (target === "spam" && text !== "spam") {
		return "specific";
	}
	return "generic";
}

function safeResolveFolder(
	folders: ProtonFolder[],
	selector: string,
): ProtonFolder | undefined {
	if (folders.length === 0) {
		return undefined;
	}
	try {
		return resolveFolder(folders, selector.trim(), { purpose: "target" });
	} catch {
		return undefined;
	}
}

function sortConventions(
	left: FilterNamingConvention,
	right: FilterNamingConvention,
): number {
	return (
		confidenceScore(right.confidence) - confidenceScore(left.confidence) ||
		scopeScore(right.scope) - scopeScore(left.scope) ||
		left.prefix.length - right.prefix.length ||
		left.prefix.localeCompare(right.prefix)
	);
}

function confidenceScore(value: FilterNamingConvention["confidence"]): number {
	return value === "high" ? 2 : 1;
}

function scopeScore(value: FilterNamingConvention["scope"]): number {
	return value === "generic" ? 2 : 1;
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

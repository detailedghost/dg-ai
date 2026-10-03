import type { MailFolder } from "../providers/types";

export type FolderInventoryEntry = {
	id: string;
	name: string;
	path: string;
	type: MailFolder["type"];
	total?: number;
	unread?: number;
	parentPath?: string;
	depth: number;
	children: number;
};

export type FolderRecommendationTarget = {
	folder: MailFolder;
	displayName: string;
};

const receiptSignals = [
	"receipt",
	"purchase",
	"payment received",
	"order confirmation",
	"delivered",
	"shipment",
];
const invoiceSignals = ["invoice", "statement", "bill"];
const creditCardSignals = [
	"capitalone",
	"americanexpress",
	"synchrony",
	"cardmessage",
];
const bankSignals = ["bank", "pnc", "truist"];
const investmentSignals = ["fidelity", "vanguard", "proxyvote", "investment"];

export function folderPath(folder: MailFolder): string {
	return folder.path?.trim() || folder.name;
}

export function folderDisplayName(folder: MailFolder): string {
	return folderPath(folder);
}

export function resolveFolder(
	folders: MailFolder[],
	target: string,
	options: { purpose?: "source" | "target"; allowMissing: true },
): MailFolder | undefined;

export function resolveFolder(
	folders: MailFolder[],
	target: string,
	options?: { purpose?: "source" | "target"; allowMissing?: false },
): MailFolder;

export function resolveFolder(
	folders: MailFolder[],
	target: string,
	options: { purpose?: "source" | "target"; allowMissing?: boolean } = {},
): MailFolder | undefined {
	const normalized = normalizeFolderSelector(target);
	if (!normalized) {
		if (options.allowMissing) {
			return undefined;
		}
		throw new Error(`folder ${options.purpose ?? "selection"} is missing`);
	}

	const idMatch = folders.find(
		(folder) => normalizeFolderSelector(folder.id) === normalized,
	);
	if (idMatch) {
		return idMatch;
	}

	const pathMatches = folders.filter(
		(folder) => normalizeFolderSelector(folderPath(folder)) === normalized,
	);
	if (pathMatches.length === 1) {
		return pathMatches[0];
	}
	if (pathMatches.length > 1) {
		throw ambiguousFolderError(target, pathMatches);
	}

	const nameMatches = folders.filter(
		(folder) => normalizeFolderSelector(folder.name) === normalized,
	);
	if (nameMatches.length === 1) {
		return nameMatches[0];
	}
	if (nameMatches.length > 1) {
		throw ambiguousFolderError(target, nameMatches);
	}

	if (options.allowMissing) {
		return undefined;
	}
	const prefix = options.purpose ? `${options.purpose} folder` : "folder";
	throw new Error(`${prefix} not found: ${target}`);
}

export function folderInventory(folders: MailFolder[]): FolderInventoryEntry[] {
	const childCounts = new Map<string, number>();
	for (const folder of folders) {
		const parent = parentPath(folderPath(folder));
		if (!parent) {
			continue;
		}
		const key = normalizeFolderSelector(parent);
		childCounts.set(key, (childCounts.get(key) ?? 0) + 1);
	}

	return folders
		.map((folder) => {
			const path = folderPath(folder);
			const parent = parentPath(path);
			return {
				id: folder.id,
				name: folder.name,
				path,
				type: folder.type,
				total: folder.total,
				unread: folder.unread,
				parentPath: parent,
				depth: path.split("/").filter(Boolean).length - 1,
				children: childCounts.get(normalizeFolderSelector(path)) ?? 0,
			};
		})
		.sort(
			(left, right) =>
				left.path.localeCompare(right.path) || left.id.localeCompare(right.id),
		);
}

export function ambiguousFolderNames(
	folders: MailFolder[],
): { name: string; matches: { id: string; path: string }[] }[] {
	const groups = new Map<string, MailFolder[]>();
	for (const folder of folders) {
		const key = normalizeFolderSelector(folder.name);
		groups.set(key, [...(groups.get(key) ?? []), folder]);
	}
	return [...groups.values()]
		.filter((group) => group.length > 1)
		.map((group) => ({
			name: group[0].name,
			matches: group.map((folder) => ({
				id: folder.id,
				path: folderPath(folder),
			})),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function inferTargetFolder(
	text: string,
	folders: MailFolder[],
	options: { excludeFolderIds?: string[]; excludeNames?: string[] } = {},
): FolderRecommendationTarget | undefined {
	const normalizedText = text.toLowerCase();
	const excludeIds = new Set(
		(options.excludeFolderIds ?? []).map(normalizeFolderSelector),
	);
	const excludeNames = new Set(
		(options.excludeNames ?? []).map(normalizeFolderSelector),
	);
	const candidates = folders.filter((folder) => {
		if (excludeIds.has(normalizeFolderSelector(folder.id))) {
			return false;
		}
		return (
			!excludeNames.has(normalizeFolderSelector(folder.name)) &&
			!excludeNames.has(normalizeFolderSelector(folderPath(folder)))
		);
	});

	if (hasAny(normalizedText, receiptSignals)) {
		return firstExistingFolder(candidates, [
			"receipt",
			"receipts",
			"transaction",
			"finance",
		]);
	}
	if (hasAny(normalizedText, invoiceSignals)) {
		return firstExistingFolder(candidates, [
			"invoice",
			"finance",
			"transaction",
			"receipt",
			"receipts",
		]);
	}
	if (hasAny(normalizedText, creditCardSignals)) {
		return firstExistingFolder(candidates, [
			"credit-card",
			"credit card",
			"bank",
			"finance",
		]);
	}
	if (hasAny(normalizedText, bankSignals)) {
		return firstExistingFolder(candidates, ["bank", "finance"]);
	}
	if (hasAny(normalizedText, investmentSignals)) {
		return firstExistingFolder(candidates, ["investments", "finance"]);
	}
	if (
		normalizedText.includes("church") ||
		normalizedText.includes("southlakebaptist")
	) {
		return firstExistingFolder(candidates, ["church"]);
	}
	if (
		normalizedText.includes("chewy") ||
		normalizedText.includes("vetcove") ||
		normalizedText.includes("pet")
	) {
		return firstExistingFolder(candidates, ["pet"]);
	}
	if (
		normalizedText.includes("calendar") ||
		normalizedText.includes("meeting") ||
		normalizedText.includes("event")
	) {
		return firstExistingFolder(candidates, ["calendar", "event"]);
	}
	if (
		normalizedText.includes("company.example") ||
		normalizedText.includes("teammate") ||
		normalizedText.includes("project follow up")
	) {
		return firstExistingFolder(candidates, ["work", "support", "pipeline"]);
	}
	return undefined;
}

export function isArchiveFolderName(value: string): boolean {
	const normalized = normalizeFolderSelector(value);
	return normalized === "archive" || normalized.endsWith("/archive");
}

export function isFilterRecommendationTarget(value: string): boolean {
	const normalized = normalizeFolderSelector(value);
	return [
		"receipt",
		"receipts",
		"credit-card",
		"credit card",
		"bank",
		"invoice",
		"pet",
		"church",
		"investments",
		"calendar",
		"hunt",
		"spam",
	].some(
		(target) =>
			normalized === target ||
			normalized.endsWith(`/${target}`) ||
			normalized.includes(`/${target}/`),
	);
}

export function normalizeFolderSelector(value: string): string {
	return value
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/+/g, "/")
		.toLowerCase();
}

function firstExistingFolder(
	folders: MailFolder[],
	candidates: string[],
): FolderRecommendationTarget | undefined {
	for (const candidate of candidates) {
		const exact = folders.find((folder) => {
			const normalizedCandidate = normalizeFolderSelector(candidate);
			return (
				normalizeFolderSelector(folder.name) === normalizedCandidate ||
				normalizeFolderSelector(folderPath(folder)) === normalizedCandidate
			);
		});
		if (exact) {
			return { folder: exact, displayName: folderDisplayName(exact) };
		}

		const leaf = folders.find((folder) =>
			normalizeFolderSelector(folder.name).includes(
				normalizeFolderSelector(candidate),
			),
		);
		if (leaf) {
			return { folder: leaf, displayName: folderDisplayName(leaf) };
		}

		const path = folders.find((folder) =>
			normalizeFolderSelector(folderPath(folder)).includes(
				normalizeFolderSelector(candidate),
			),
		);
		if (path) {
			return { folder: path, displayName: folderDisplayName(path) };
		}
	}
	return undefined;
}

function hasAny(text: string, signals: string[]): boolean {
	return signals.some((signal) => text.includes(signal));
}

function parentPath(path: string): string | undefined {
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 1) {
		return undefined;
	}
	return parts.slice(0, -1).join("/");
}

function ambiguousFolderError(target: string, matches: MailFolder[]): Error {
	const choices = matches
		.map((folder) => `${folder.id} (${folderPath(folder)})`)
		.join(", ");
	return new Error(
		`Ambiguous folder "${target}". Use an exact folder id or path. Matches: ${choices}`,
	);
}

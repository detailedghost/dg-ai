import { join } from "node:path";
import { getBooleanFlag, getNumberFlag, getStringFlag } from "../cli/args";
import { workspaceDirForContext, type CliContext } from "../cli/context";
import { printJson } from "../cli/output";
import type {
	MessageDecision,
	MessageStatusEntry,
	MessageWorkItem,
} from "../workspace/types";
import {
	readFolders,
	readLabels,
	readMessageStatus,
	readMessageWorkItems,
	updateMessageDecisions,
	workspacePaths,
} from "../workspace/store";
import {
	folderDisplayName,
	folderInventory,
	inferTargetFolder,
	isArchiveFolderName,
	isFilterRecommendationTarget,
	normalizeFolderSelector,
	resolveFolder,
	ambiguousFolderNames,
} from "../workspace/folders";

type Selector = {
	domain?: string;
	domainContains?: string;
	status?: string;
	folder?: string;
	decisionAction?: string;
	ids?: Set<string>;
};

type Proposal = {
	id: string;
	file: string;
	fromDomain: string;
	subject: string;
	action: MessageDecision["action"];
	targetFolder?: string;
	markRead?: boolean;
	confidence: number;
	reason: string;
	filterGap?: string;
};

export async function analyzeWorkspace(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const by = getStringFlag(context.args.flags, "by", "domain");
	const limit = getNumberFlag(context.args.flags, "limit", 25);
	const status = await readMessageStatus(paths);
	const rows = filterStatusEntries(status.items, selectorFromContext(context));
	const groups = groupStatusRows(rows, by).slice(0, limit);
	printJson({
		kind: "workspace-analysis",
		by,
		total: rows.length,
		groups,
	});
}

export async function sampleWorkspace(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const limit = getNumberFlag(context.args.flags, "limit", 10);
	const items = filterWorkItems(
		await readMessageWorkItems(paths),
		selectorFromContext(context),
	).slice(0, limit);
	printJson({
		kind: "workspace-sample",
		total: items.length,
		samples: items.map((item) => ({
			id: item.id,
			file: item.file,
			status: item.status,
			currentFolder: item.currentFolder,
			fromDomain: item.packet.fromDomain,
			subject: item.packet.subject,
			snippet: item.packet.snippet,
			decision: item.decision,
		})),
	});
}

export async function suggestWorkspace(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const limit = getNumberFlag(context.args.flags, "limit", 100);
	const proposalLimit = getNumberFlag(context.args.flags, "proposal-limit", 25);
	const write = getBooleanFlag(context.args.flags, "write");
	const [folders, items] = await Promise.all([
		readFolders(paths),
		readMessageWorkItems(paths),
	]);
	const selected = filterWorkItems(items, selectorFromContext(context)).slice(
		0,
		limit,
	);
	const proposals = selected.map((item) => suggestDecision(item, folders));
	let written = 0;
	if (write) {
		const updates = new Map(
			proposals.map((proposal) => [
				proposal.id,
				decisionFromProposal(proposal),
			]),
		);
		written = (await updateMessageDecisions(paths, updates)).written;
	}
	printJson({
		kind: "workspace-suggestions",
		total: proposals.length,
		write,
		written,
		counts: countProposals(proposals),
		targetFolders: countTargetFolders(proposals),
		proposals: proposals.slice(0, proposalLimit),
		proposalsShown: Math.min(proposals.length, proposalLimit),
	});
}

export async function decideWorkspace(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const action = getStringFlag(
		context.args.flags,
		"action",
	) as MessageDecision["action"];
	if (!["move", "review", "skip", "keep"].includes(action)) {
		throw new Error("decide requires --action move|review|skip|keep");
	}
	const [folders, items] = await Promise.all([
		readFolders(paths),
		readMessageWorkItems(paths),
	]);
	const selector = {
		...selectorFromContext(context),
		ids: await loadIdsSelector(context),
	};
	const selected = filterWorkItems(items, selector);
	const targetFolder = getStringFlag(context.args.flags, "target-folder");
	const resolvedTarget = targetFolder
		? folderDisplayName(
				resolveFolder(folders, targetFolder, { purpose: "target" })!,
			)
		: undefined;
	if (action === "move" && !resolvedTarget) {
		throw new Error(`target folder not found: ${targetFolder || "<missing>"}`);
	}
	const onlyTargetMismatch = getBooleanFlag(
		context.args.flags,
		"only-target-mismatch",
	);
	const reason = getStringFlag(
		context.args.flags,
		"reason",
		defaultReason(action, resolvedTarget),
	);
	const markRead =
		context.args.flags["mark-read"] === undefined
			? action === "move"
			: getBooleanFlag(context.args.flags, "mark-read");
	const updates = new Map<string, MessageDecision>();
	for (const item of selected) {
		if (
			onlyTargetMismatch &&
			resolvedTarget &&
			normalize(item.decision?.targetFolder ?? item.currentFolder) ===
				normalize(resolvedTarget)
		) {
			continue;
		}
		updates.set(item.id, {
			action,
			...(resolvedTarget ? { targetFolder: resolvedTarget } : {}),
			...(markRead ? { markRead: true } : {}),
			confidence: action === "move" ? 0.9 : 0.5,
			reason,
			...(action === "move" && resolvedTarget
				? {
						filterGap: `Consider a Proton filter for ${item.packet.fromDomain} to ${resolvedTarget}.`,
					}
				: {}),
		});
	}
	const result = await updateMessageDecisions(paths, updates);
	printJson({
		kind: "workspace-decisions-written",
		matched: result.matched,
		written: result.written,
		action,
		targetFolder: resolvedTarget,
		statusPath: paths.status,
	});
}

export async function inventoryFolders(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const folders = await readFolders(paths);
	const inventory = folderInventory(folders);
	printJson({
		kind: "workspace-folder-inventory",
		dir: paths.dir,
		total: inventory.length,
		folders: inventory,
		ambiguousNames: ambiguousFolderNames(folders),
		recursiveSourceScan: false,
		warning:
			"Folder source scans are exact. Use an id or full path for duplicate folder names.",
	});
}

export async function inventoryLabels(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const labels = await readLabels(paths);
	printJson({
		kind: "workspace-label-inventory",
		dir: paths.dir,
		total: labels.length,
		labels: labels.map((label) => ({
			id: label.id,
			name: label.name,
			color: label.color,
			type: label.type,
		})),
	});
}

export async function recommendFilters(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const sampleLimit = getNumberFlag(context.args.flags, "sample-limit", 3);
	const writeArchiveDecisions = getBooleanFlag(
		context.args.flags,
		"write-archive-decisions",
	);
	const [folders, items] = await Promise.all([
		readFolders(paths),
		readMessageWorkItems(paths),
	]);
	const recommendations = buildFilterRecommendations(
		items,
		folders,
		sampleLimit,
	);
	let archiveDecisionUpdates = 0;

	if (writeArchiveDecisions) {
		const updates = new Map<string, MessageDecision>();
		for (const followup of recommendations.archiveFollowups.filter(
			(row) => row.safeForDomainFilter,
		)) {
			for (const id of followup.itemIds) {
				updates.set(id, {
					action: "move",
					targetFolder: followup.targetFolder,
					markRead: true,
					confidence: 0.82,
					reason: `Archive follow-up: route this handled message to ${followup.targetFolder}.`,
					filterGap: followup.safeForDomainFilter
						? `Create a Proton filter for ${followup.domain} to ${followup.targetFolder}.`
						: `Do not use a domain-only filter for ${followup.domain}; use subject or sender conditions.`,
				});
			}
		}
		archiveDecisionUpdates = (await updateMessageDecisions(paths, updates))
			.written;
	}

	const output = {
		kind: "workspace-filter-recommendations",
		createdAt: new Date().toISOString(),
		dir: paths.dir,
		liveMutation: false,
		automaticApply: false,
		writeArchiveDecisions,
		archiveDecisionUpdates,
		out: join(paths.plansDir, "filter-recommendations.json"),
		...recommendations,
	};
	await Bun.write(output.out, `${JSON.stringify(output, null, 2)}\n`);
	printJson(output);
}

function getWorkspaceDir(context: CliContext): string {
	return workspaceDirForContext(context);
}

function selectorFromContext(context: CliContext): Selector {
	return {
		domain: getStringFlag(context.args.flags, "domain"),
		domainContains: getStringFlag(context.args.flags, "domain-contains"),
		status: getStringFlag(context.args.flags, "status"),
		folder: getStringFlag(context.args.flags, "folder"),
		decisionAction: getStringFlag(context.args.flags, "decision-action"),
	};
}

/**
 * Restrict a decision to an explicit set of work-item ids, from `--ids-file`
 * (one id per line, `#` comments and blanks ignored, or a JSON array) and/or a
 * comma-separated `--ids`. Lets a precise, reviewed set drive the move instead
 * of the coarse domain/folder selectors.
 */
async function loadIdsSelector(
	context: CliContext,
): Promise<Set<string> | undefined> {
	const ids = new Set<string>();
	const inline = getStringFlag(context.args.flags, "ids");
	if (inline) {
		for (const id of inline.split(",")) {
			const trimmed = id.trim();
			if (trimmed) {
				ids.add(trimmed);
			}
		}
	}
	const file = getStringFlag(context.args.flags, "ids-file");
	if (file) {
		const raw = await Bun.file(file).text();
		const parsed = raw.trimStart().startsWith("[")
			? (JSON.parse(raw) as unknown[]).map(String)
			: raw
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line && !line.startsWith("#"));
		for (const id of parsed) {
			ids.add(id);
		}
	}
	return ids.size > 0 ? ids : undefined;
}

function filterStatusEntries(
	items: MessageStatusEntry[],
	selector: Selector,
): MessageStatusEntry[] {
	return items.filter((item) =>
		matchesSelector(
			{
				id: item.id,
				status: item.status,
				currentFolder: item.currentFolder,
				packet: { fromDomain: item.fromDomain },
				decision: item.decision,
			},
			selector,
		),
	);
}

function filterWorkItems(
	items: MessageWorkItem[],
	selector: Selector,
): MessageWorkItem[] {
	return items.filter((item) => matchesSelector(item, selector));
}

function matchesSelector(
	item: {
		id: string;
		status: string;
		currentFolder: string;
		packet: { fromDomain: string };
		decision?: { action: string };
	},
	selector: Selector,
): boolean {
	if (selector.ids && !selector.ids.has(item.id)) {
		return false;
	}
	if (selector.domain && item.packet.fromDomain !== selector.domain) {
		return false;
	}
	if (
		selector.domainContains &&
		!item.packet.fromDomain.includes(selector.domainContains)
	) {
		return false;
	}
	if (selector.status && item.status !== selector.status) {
		return false;
	}
	if (
		selector.folder &&
		normalize(item.currentFolder) !== normalize(selector.folder)
	) {
		return false;
	}
	if (
		selector.decisionAction &&
		item.decision?.action !== selector.decisionAction
	) {
		return false;
	}
	return true;
}

function groupStatusRows(
	rows: MessageStatusEntry[],
	by: string,
): { key: string; count: number; statuses: Record<string, number> }[] {
	const groups = new Map<
		string,
		{ key: string; count: number; statuses: Record<string, number> }
	>();
	for (const row of rows) {
		const key = groupKey(row, by);
		const group = groups.get(key) ?? { key, count: 0, statuses: {} };
		group.count += 1;
		group.statuses[row.status] = (group.statuses[row.status] ?? 0) + 1;
		groups.set(key, group);
	}
	return [...groups.values()].sort(
		(left, right) =>
			right.count - left.count || left.key.localeCompare(right.key),
	);
}

function groupKey(row: MessageStatusEntry, by: string): string {
	if (by === "status") {
		return row.status;
	}
	if (by === "folder") {
		return row.currentFolder;
	}
	if (by !== "domain") {
		throw new Error("analyze --by must be domain, status, or folder");
	}
	return row.fromDomain;
}

function suggestDecision(
	item: MessageWorkItem,
	folders: Awaited<ReturnType<typeof readFolders>>,
): Proposal {
	const text =
		`${item.packet.fromDomain} ${item.packet.subject} ${item.packet.snippet}`.toLowerCase();
	const target = inferTargetFolder(text, folders)?.displayName;
	if (!target) {
		return {
			id: item.id,
			file: item.file,
			fromDomain: item.packet.fromDomain,
			subject: item.packet.subject,
			action: "review",
			confidence: 0.35,
			reason:
				"No high-confidence existing folder matched this redacted summary.",
		};
	}
	return {
		id: item.id,
		file: item.file,
		fromDomain: item.packet.fromDomain,
		subject: item.packet.subject,
		action: "move",
		targetFolder: target,
		markRead: true,
		confidence: 0.85,
		reason: `Matched existing ${target} folder from redacted domain/subject signals.`,
		filterGap: `Consider a Proton filter for ${item.packet.fromDomain} to ${target}.`,
	};
}

function decisionFromProposal(proposal: Proposal): MessageDecision {
	return {
		action: proposal.action,
		...(proposal.targetFolder ? { targetFolder: proposal.targetFolder } : {}),
		...(proposal.markRead ? { markRead: true } : {}),
		confidence: proposal.confidence,
		reason: proposal.reason,
		...(proposal.filterGap ? { filterGap: proposal.filterGap } : {}),
	};
}

function countProposals(
	proposals: Proposal[],
): Record<MessageDecision["action"], number> {
	const counts: Record<MessageDecision["action"], number> = {
		move: 0,
		keep: 0,
		review: 0,
		skip: 0,
	};
	for (const proposal of proposals) {
		counts[proposal.action] += 1;
	}
	return counts;
}

function countTargetFolders(
	proposals: Proposal[],
): { folder: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const proposal of proposals) {
		if (proposal.action !== "move" || !proposal.targetFolder) {
			continue;
		}
		counts.set(
			proposal.targetFolder,
			(counts.get(proposal.targetFolder) ?? 0) + 1,
		);
	}
	return [...counts.entries()]
		.sort(
			(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
		)
		.map(([folder, count]) => ({ folder, count }));
}

function defaultReason(
	action: MessageDecision["action"],
	targetFolder?: string,
): string {
	if (action === "move") {
		return `Bulk local decision to move handled messages to ${targetFolder}.`;
	}
	if (action === "review") {
		return "Bulk local decision marked these messages for review.";
	}
	return `Bulk local decision set action ${action}.`;
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function buildFilterRecommendations(
	items: MessageWorkItem[],
	folders: Awaited<ReturnType<typeof readFolders>>,
	sampleLimit: number,
): {
	filterRecommendations: ReturnType<typeof recommendationRows>;
	archiveFollowups: ReturnType<typeof archiveFollowupRows>;
	unsafeDomains: { domain: string; targetFolders: string[]; reason: string }[];
	informational: { targetFolder: string; count: number; reason: string }[];
} {
	const moved = items.filter(
		(item) => item.decision?.action === "move" && item.decision.targetFolder,
	);
	const domainTargets = new Map<string, Set<string>>();
	for (const item of moved) {
		const domain = item.packet.fromDomain || "unknown";
		const target = item.decision?.targetFolder ?? "";
		if (isArchiveFolderName(target)) {
			continue;
		}
		const set = domainTargets.get(domain) ?? new Set<string>();
		set.add(target);
		domainTargets.set(domain, set);
	}

	const archiveFollowups = archiveFollowupRows(
		moved,
		folders,
		domainTargets,
		sampleLimit,
	);
	for (const followup of archiveFollowups) {
		const set = domainTargets.get(followup.domain) ?? new Set<string>();
		set.add(followup.targetFolder);
		domainTargets.set(followup.domain, set);
	}

	const unsafeDomains = [...domainTargets.entries()]
		.filter(([, targets]) => targets.size > 1)
		.map(([domain, targets]) => ({
			domain,
			targetFolders: [...targets].sort(),
			reason:
				"Domain appears in multiple target folders; use subject, sender, or action conditions instead of a domain-only filter.",
		}))
		.sort((left, right) => left.domain.localeCompare(right.domain));

	return {
		filterRecommendations: recommendationRows(
			moved,
			domainTargets,
			sampleLimit,
		),
		archiveFollowups: archiveFollowups.map((row) => ({
			...row,
			safeForDomainFilter: (domainTargets.get(row.domain)?.size ?? 0) === 1,
			warning:
				(domainTargets.get(row.domain)?.size ?? 0) === 1
					? undefined
					: "Mixed target domain; do not create a domain-only filter.",
		})),
		unsafeDomains,
		informational: archiveInformationRows(moved),
	};
}

function recommendationRows(
	items: MessageWorkItem[],
	domainTargets: Map<string, Set<string>>,
	sampleLimit: number,
) {
	const groups = new Map<
		string,
		{ domain: string; targetFolder: string; count: number; samples: unknown[] }
	>();
	for (const item of items) {
		const target = item.decision?.targetFolder ?? "";
		if (
			!target ||
			isArchiveFolderName(target) ||
			!isFilterRecommendationTarget(target)
		) {
			continue;
		}
		const domain = item.packet.fromDomain || "unknown";
		const key = `${target}\u0000${domain}`;
		const group = groups.get(key) ?? {
			domain,
			targetFolder: target,
			count: 0,
			samples: [],
		};
		group.count += 1;
		if (group.samples.length < sampleLimit) {
			group.samples.push(sampleForItem(item));
		}
		groups.set(key, group);
	}
	return [...groups.values()]
		.map((group) => ({
			...group,
			safeForDomainFilter: (domainTargets.get(group.domain)?.size ?? 0) === 1,
			automaticApply: false,
			warning:
				(domainTargets.get(group.domain)?.size ?? 0) === 1
					? undefined
					: "Mixed target domain; do not create a domain-only filter.",
			recommendation:
				(domainTargets.get(group.domain)?.size ?? 0) === 1
					? `Create or update a Proton filter for ${group.domain} to ${group.targetFolder}.`
					: `Use narrower Proton filter conditions for ${group.domain} before moving to ${group.targetFolder}.`,
		}))
		.sort(
			(left, right) =>
				right.count - left.count ||
				left.targetFolder.localeCompare(right.targetFolder) ||
				left.domain.localeCompare(right.domain),
		);
}

function archiveFollowupRows(
	items: MessageWorkItem[],
	folders: Awaited<ReturnType<typeof readFolders>>,
	domainTargets: Map<string, Set<string>>,
	sampleLimit: number,
) {
	const groups = new Map<
		string,
		{
			domain: string;
			sourceFolder: string;
			targetFolder: string;
			count: number;
			samples: unknown[];
			itemIds: string[];
			safeForDomainFilter: boolean;
		}
	>();
	for (const item of items) {
		const target = item.decision?.targetFolder ?? item.currentFolder;
		if (!isArchiveFolderName(target)) {
			continue;
		}
		const domain = item.packet.fromDomain || "unknown";
		const inferred = inferTargetFolder(
			`${item.packet.fromDomain} ${item.packet.subject} ${item.packet.snippet}`,
			folders,
			{
				excludeNames: ["Archive"],
			},
		);
		const priorTargets = domainTargets.get(domain);
		const priorTarget =
			priorTargets?.size === 1 ? [...priorTargets][0] : undefined;
		const targetFolder =
			inferred && !isArchiveFolderName(inferred.displayName)
				? inferred.displayName
				: priorTarget;
		if (!targetFolder || isArchiveFolderName(targetFolder)) {
			continue;
		}
		const key = `${targetFolder}\u0000${domain}`;
		const group = groups.get(key) ?? {
			domain,
			sourceFolder: "Archive",
			targetFolder,
			count: 0,
			samples: [],
			itemIds: [],
			safeForDomainFilter: (domainTargets.get(domain)?.size ?? 0) <= 1,
		};
		group.count += 1;
		group.itemIds.push(item.id);
		if (group.samples.length < sampleLimit) {
			group.samples.push(sampleForItem(item));
		}
		groups.set(key, group);
	}
	return [...groups.values()].sort(
		(left, right) =>
			right.count - left.count ||
			left.targetFolder.localeCompare(right.targetFolder) ||
			left.domain.localeCompare(right.domain),
	);
}

function archiveInformationRows(
	items: MessageWorkItem[],
): { targetFolder: string; count: number; reason: string }[] {
	const archiveCount = items.filter((item) =>
		isArchiveFolderName(item.decision?.targetFolder ?? item.currentFolder),
	).length;
	return archiveCount > 0
		? [
				{
					targetFolder: "Archive",
					count: archiveCount,
					reason:
						"Archive is informational only. Do not create a broad Archive filter; sample domains first and route specific senders to concrete folders or Spam.",
				},
			]
		: [];
}

function sampleForItem(item: MessageWorkItem): {
	id: string;
	subject: string;
	snippet: string;
} {
	return {
		id: item.id,
		subject: item.packet.subject,
		snippet: item.packet.snippet,
	};
}

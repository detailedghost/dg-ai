import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getBooleanFlag, getNumberFlag, getStringFlag } from "../cli/args";
import type { CliContext } from "../cli/context";
import { printJson } from "../cli/output";

import { packetForMessage } from "../classifier/packets";
import { ensureConfigHome } from "../config/home";
import {
	createMailProviderClient,
	providerBatchSize,
	providerSnippetLength,
	resolveProvider,
} from "../providers/factory";
import type {
	ListMessagesInput,
	MailMessageSummary,
	MailProvider,
	MailProviderClient,
} from "../providers/types";
import { readJsonFileIfExists as readJsonIfExists } from "../utils/json";
import { folderDisplayName, resolveFolder } from "../workspace/folders";
import {
	accountProfileSlug,
	workspaceDirForProfile,
} from "../workspace/profile";
import {
	cleanupWarning,
	cleanupWorkspace,
	applyWorkspaceMutations,
	dryRunWorkspaceApply,
	readFolders,
	writeLabels,
	readMessageStatus,
	readMessageWorkItems,
	workspacePaths,
	writeClassificationGuide,
	writeFilters,
	writeFolders,
	writeLogin,
	writeMessageBatch,
	writeMessageBatchStream,
	writeReviewPlan,
} from "../workspace/store";

export async function initWorkspace(context: CliContext): Promise<void> {
	const username = getStringFlag(context.args.flags, "username");
	if (!username) {
		throw new Error("init requires --username <email>");
	}
	const paths = workspacePaths(getWorkspaceDir(context));
	const accountProfile = accountProfileSlug(
		getStringFlag(context.args.flags, "account-profile"),
	);
	const [login, configHome] = await Promise.all([
		writeLogin(paths, context.config, username, { accountProfile }),
		ensureConfigHome(context.config.configHome),
	]);
	printJson({
		kind: "workspace-init",
		provider: login.provider ?? context.config.provider,
		dir: paths.dir,
		configHome: context.config.configHome,
		configFiles: {
			routeProfiles: configHome.routeProfilesPath,
			mappings: configHome.mappingsPath,
			security: configHome.securityPath,
			created: configHome.created,
		},
		loginPath: paths.login,
		accountProfile: login.accountProfile,
		accountConfigured: Boolean(login.username),
		liveBrowser: login.liveBrowser,
		browserType: login.browserType,
		browserHeadless: login.browserHeadless,
		browserExecutablePath: login.browserExecutablePath,
		warning: "Login metadata only. Passwords and raw tokens are not stored.",
	});
}

export async function loginWorkspace(context: CliContext): Promise<void> {
	const client = createMailProviderClient(
		context.config,
		currentProvider(context),
	);
	try {
		await client.listFolders();
		printJson({
			kind: "workspace-login",
			provider: client.provider,
			authenticated: true,
		});
	} finally {
		await client.close?.();
	}
}

export async function loadFolders(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const provider = currentProvider(context);
	const client = createMailProviderClient(context.config, provider);
	try {
		const folders = await client.listFolders();
		await writeFolders(paths, folders, client.provider);
		printJson({
			kind: "workspace-load-folders",
			provider: client.provider,
			out: paths.folders,
			count: folders.length,
		});
	} finally {
		await client.close?.();
	}
}

export async function loadLabels(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const provider = currentProvider(context);
	const client = createMailProviderClient(context.config, provider);
	try {
		if (client.listLabels) {
			const labels = await client.listLabels();
			await writeLabels(paths, labels, client.provider);
			printJson({
				kind: "workspace-load-labels",
				provider: client.provider,
				out: paths.labels,
				count: labels.length,
			});
			return;
		}

		const folders = await client.listFolders();
		await writeFolders(paths, folders, client.provider);
		printJson({
			kind: "workspace-load-labels",
			provider: client.provider,
			out: paths.folders,
			count: folders.length,
			warning: "Provider exposes labels through folder snapshots.",
		});
	} finally {
		await client.close?.();
	}
}

export async function loadFilters(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const provider = currentProvider(context);
	const client = createMailProviderClient(context.config, provider);
	try {
		const filters = await client.listFilters();
		await writeFilters(
			paths,
			filters,
			providerSnippetLength(context.config, client.provider),
			client.provider,
		);
		printJson({
			kind: "workspace-load-filters",
			provider: client.provider,
			out: paths.filters,
			count: filters.length,
			redacted: true,
		});
	} finally {
		await client.close?.();
	}
}

export async function createClassificationDoc(
	context: CliContext,
): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const guide = await writeClassificationGuide(paths);
	printJson({
		kind: "workspace-classification-guide",
		out: paths.classificationGuide,
		folders: Array.isArray(guide.folders) ? guide.folders.length : 0,
		filters: Array.isArray(guide.filters) ? guide.filters.length : 0,
		modelHint: `Use the fastest/cheapest adequate model for sorting and summaries. Default configured model: ${context.config.classifier.model}. Prefer Codex-local review for this CLI.`,
	});
}

export async function batchMessages(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const folder = getStringFlag(context.args.flags, "folder", "inbox");
	const provider = currentProvider(context);
	const limit = getNumberFlag(
		context.args.flags,
		"limit",
		providerBatchSize(context.config, provider),
	);
	// `--concurrency` is the legacy alias for `--workers` (thread count); 0/unset
	// means auto (scale to cores), and it also bounds chunks in flight.
	const workers = getNumberFlag(
		context.args.flags,
		"workers",
		getNumberFlag(context.args.flags, "concurrency", 0),
	);
	const client = createMailProviderClient(context.config, provider);
	try {
		const folders = await readFolders(paths);
		const resolvedFolder = resolveFolder(folders, folder, {
			purpose: "source",
		});
		const status = await writeMessageBatchStream({
			paths,
			folders,
			pages: streamProviderMessages(client, {
				folderId: resolvedFolder.id,
				folderName: resolvedFolder.name,
				limit,
			}),
			snippetLength: providerSnippetLength(context.config, client.provider),
			provider: client.provider,
			workers: workers > 0 ? workers : undefined,
		});
		printJson({
			kind: "workspace-batch",
			provider: client.provider,
			dir: join(paths.dir, "messages"),
			statusPath: paths.status,
			total: status.total,
			concurrency: workers > 0 ? workers : "auto",
			warning:
				"Created one redacted file per message for Codex-assisted cleanup.",
		});
	} finally {
		await client.close?.();
	}
}

export async function relocateFolder(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const provider = currentProvider(context);
	const sourceSelector = getStringFlag(context.args.flags, "folder");
	if (!sourceSelector) {
		throw new Error("folders relocate requires --folder <source id or path>");
	}
	const toSelector = getStringFlag(context.args.flags, "to");
	const rename = getStringFlag(context.args.flags, "rename");
	if (!toSelector && !rename) {
		throw new Error(
			"folders relocate requires --to <parent|root> and/or --rename <name>",
		);
	}
	const folders = await readFolders(paths);
	const source = resolveFolder(folders, sourceSelector, { purpose: "source" });
	const client = createMailProviderClient(context.config, provider);
	try {
		if (!client.moveFolder || !client.renameFolder) {
			throw new Error(`${provider} client does not support folder relocation`);
		}
		let movedTo: string | undefined;
		if (toSelector) {
			const destinationId =
				toSelector.toLowerCase() === "root"
					? "msgfolderroot"
					: resolveFolder(folders, toSelector, { purpose: "target" }).id;
			await client.moveFolder({ id: source.id, destinationId });
			movedTo = toSelector;
		}
		if (rename) {
			await client.renameFolder({ id: source.id, displayName: rename });
		}
		// Refresh the local snapshot so the next planning/routing step sees the new
		// structure without a separate `load folders`.
		const refreshed = await client.listFolders();
		await writeFolders(paths, refreshed, client.provider);
		printJson({
			kind: "workspace-folder-relocated",
			provider,
			source: folderDisplayName(source),
			movedTo,
			renamedTo: rename,
			folders: refreshed.length,
			out: paths.folders,
		});
	} finally {
		await client.close?.();
	}
}

/**
 * Yields provider pages lazily so `batch` can start writing before the fetch
 * finishes. Providers that implement `listMessagesStream` (Outlook) stream page
 * by page; the rest fall back to a single page from `listMessages`.
 */
async function* streamProviderMessages(
	client: MailProviderClient,
	input: ListMessagesInput,
): AsyncGenerator<MailMessageSummary[]> {
	if (client.listMessagesStream) {
		yield* client.listMessagesStream(input);
		return;
	}
	const messages = await client.listMessages(input);
	if (messages.length > 0) {
		yield messages;
	}
}

export async function reviewWorkspace(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const review = (await writeReviewPlan(paths)) as {
		total?: number;
		readyToMove?: number;
		readyToMarkRead?: number;
		needsReview?: number;
		filterRecommendations?: unknown[];
		folderRecommendations?: unknown[];
	};
	printJson({
		kind: "workspace-review-created",
		out: join(paths.plansDir, "review.json"),
		review: {
			total: review.total,
			readyToMove: review.readyToMove,
			readyToMarkRead: review.readyToMarkRead,
			needsReview: review.needsReview,
			filterRecommendations: review.filterRecommendations,
			folderRecommendationsShown: Math.min(
				review.folderRecommendations?.length ?? 0,
				25,
			),
			folderRecommendations: review.folderRecommendations?.slice(0, 25),
		},
	});
}

export async function applyWorkspace(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const dryRun = getBooleanFlag(context.args.flags, "dry-run");
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	if (dryRun && confirm) {
		throw new Error("apply accepts either --dry-run or --confirm, not both");
	}
	if (dryRun) {
		const summary = await dryRunWorkspaceApply(paths);
		printJson(summary);
		return;
	}
	if (!confirm) {
		throw new Error("mailbox apply requires --dry-run or --confirm");
	}
	const provider = currentProvider(context);
	const client = createMailProviderClient(context.config, provider);
	try {
		const summary = await applyWorkspaceMutations(paths, client);
		printJson(summary);
	} finally {
		await client.close?.();
	}
}

export async function cleanupWorkspaceCommand(
	context: CliContext,
): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	const warning = cleanupWarning(paths);
	if (!confirm) {
		printJson({ kind: "workspace-cleanup-warning", warning, deleted: false });
		throw new Error("cleanup requires --confirm");
	}
	const deleted = await cleanupWorkspace(paths);
	printJson({
		kind: "workspace-cleanup",
		warning,
		deleted,
		preserved: paths.login,
	});
}

export async function statusWorkspace(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const status = await readMessageStatus(paths);
	if (getBooleanFlag(context.args.flags, "full")) {
		printJson(status);
		return;
	}
	printJson({
		kind: status.kind,
		createdAt: status.createdAt,
		updatedAt: status.updatedAt,
		total: status.total,
		counts: status.counts,
		statusPath: paths.status,
		messageFilesGlob: "messages/*.json",
		full: false,
	});
}

export async function summarizeWorkspace(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const [status, items, review, dryRun, apply, latestAudit] = await Promise.all(
		[
			readMessageStatus(paths),
			readMessageWorkItems(paths),
			readJsonIfExists<Record<string, unknown>>(
				join(paths.plansDir, "review.json"),
			),
			readJsonIfExists<Record<string, unknown>>(
				join(paths.reportsDir, "dry-run.json"),
			),
			readJsonIfExists<Record<string, unknown>>(
				join(paths.reportsDir, "apply.json"),
			),
			readLatestAudit(paths.auditDir),
		],
	);
	const decisions = summarizeDecisions(items);
	printJson({
		kind: "workspace-summary",
		dir: paths.dir,
		status: {
			total: status.total,
			counts: status.counts,
			statusPath: paths.status,
		},
		decisions,
		review: review
			? {
					path: join(paths.plansDir, "review.json"),
					total: numberValue(review.total),
					readyToMove: numberValue(review.readyToMove),
					readyToMarkRead: numberValue(review.readyToMarkRead),
					needsReview: numberValue(review.needsReview),
					filterRecommendations: Array.isArray(review.filterRecommendations)
						? review.filterRecommendations
						: [],
				}
			: undefined,
		dryRun: dryRun
			? {
					path: join(paths.reportsDir, "dry-run.json"),
					total: numberValue(dryRun.total),
					ready: numberValue(dryRun.ready),
					markRead: numberValue(dryRun.markRead),
					review: numberValue(dryRun.review),
					skipped: numberValue(dryRun.skipped),
					planFingerprint: stringValue(dryRun.planFingerprint),
				}
			: undefined,
		apply: apply
			? {
					path: join(paths.reportsDir, "apply.json"),
					total: numberValue(apply.total),
					moved: numberValue(apply.moved),
					markRead: numberValue(apply.markRead),
					review: numberValue(apply.review),
					skipped: numberValue(apply.skipped),
					auditPath: stringValue(apply.auditPath),
				}
			: undefined,
		latestAudit,
	});
}

export async function probeFolder(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const folder = getStringFlag(context.args.flags, "folder", "inbox");
	const provider = currentProvider(context);
	const limit = getNumberFlag(
		context.args.flags,
		"limit",
		providerBatchSize(context.config, provider),
	);
	const groupLimit = getNumberFlag(context.args.flags, "group-limit", 25);
	const client = createMailProviderClient(context.config, provider);
	try {
		const folders = await readFolders(paths);
		const resolvedFolder = resolveFolder(folders, folder, {
			purpose: "source",
		});
		const messages = await client.listMessages({
			folderId: resolvedFolder.id,
			folderName: resolvedFolder.name,
			limit,
		});
		const packets = messages.map((message) => ({
			message,
			packet: packetForMessage(
				message,
				folders,
				providerSnippetLength(context.config, client.provider),
			),
		}));
		printJson({
			kind: "workspace-probe",
			provider: client.provider,
			dir: paths.dir,
			dryRun: true,
			mutated: false,
			folder: {
				requested: folder,
				id: resolvedFolder.id,
				name: resolvedFolder.name,
				path: resolvedFolder.path,
				snapshotTotal: resolvedFolder.total,
				snapshotUnread: resolvedFolder.unread,
			},
			limit,
			fetched: messages.length,
			reachedLimit: messages.length >= limit,
			readState: countReadState(messages),
			topDomains: groupByDomain(packets, groupLimit),
			warning:
				"Read-only folder probe. No mailbox or local message files were changed.",
		});
	} finally {
		await client.close?.();
	}
}

function getWorkspaceDir(context: CliContext): string {
	return workspaceDirForProfile({
		provider: currentProvider(context),
		explicitDir: getStringFlag(context.args.flags, "dir"),
		accountProfile: getStringFlag(context.args.flags, "account-profile"),
	});
}

function currentProvider(context: CliContext): MailProvider {
	return resolveProvider(
		context.config,
		getStringFlag(context.args.flags, "provider"),
	);
}

function summarizeDecisions(
	items: Awaited<ReturnType<typeof readMessageWorkItems>>,
): unknown {
	const actions: Record<string, number> = {};
	const targetFolders = new Map<string, number>();
	let markRead = 0;
	for (const item of items) {
		const action = item.decision?.action ?? "none";
		actions[action] = (actions[action] ?? 0) + 1;
		if (item.decision?.targetFolder) {
			targetFolders.set(
				item.decision.targetFolder,
				(targetFolders.get(item.decision.targetFolder) ?? 0) + 1,
			);
		}
		if (item.decision?.markRead === true) {
			markRead += 1;
		}
	}
	return {
		actions,
		markRead,
		targetFolders: sortedCountMap(targetFolders).map(([folder, count]) => ({
			folder,
			count,
		})),
	};
}

async function readLatestAudit(auditDir: string): Promise<unknown> {
	if (!existsSync(auditDir)) {
		return undefined;
	}
	const files = (await readdir(auditDir))
		.filter((file) => file.startsWith("apply-") && file.endsWith(".json"))
		.sort();
	const latest = files.at(-1);
	if (!latest) {
		return undefined;
	}
	const path = join(auditDir, latest);
	const audit = await readJsonIfExists<{
		moved?: unknown[];
		markedRead?: unknown[];
		createdAt?: unknown;
	}>(path);
	if (!audit) {
		return undefined;
	}
	const moved = Array.isArray(audit.moved) ? audit.moved : [];
	const targetFolders = new Map<string, number>();
	for (const move of moved) {
		if (isRecord(move) && typeof move.targetFolder === "string") {
			targetFolders.set(
				move.targetFolder,
				(targetFolders.get(move.targetFolder) ?? 0) + 1,
			);
		}
	}
	return {
		path,
		createdAt: stringValue(audit.createdAt),
		moved: moved.length,
		markedRead: Array.isArray(audit.markedRead) ? audit.markedRead.length : 0,
		movedByFolder: sortedCountMap(targetFolders).map(([folder, count]) => ({
			folder,
			count,
		})),
	};
}

function countReadState(
	messages: MailMessageSummary[],
): Record<string, number> {
	const counts = { read: 0, unread: 0, unknown: 0 };
	for (const message of messages) {
		const isRead = message.read ?? message.isRead;
		if (isRead === true) {
			counts.read += 1;
		} else if (isRead === false) {
			counts.unread += 1;
		} else {
			counts.unknown += 1;
		}
	}
	return counts;
}

function groupByDomain(
	packets: { packet: { fromDomain: string }; message: MailMessageSummary }[],
	limit: number,
): {
	domain: string;
	count: number;
	read: number;
	unread: number;
	unknown: number;
}[] {
	const groups = new Map<
		string,
		{
			domain: string;
			count: number;
			read: number;
			unread: number;
			unknown: number;
		}
	>();
	for (const { packet, message } of packets) {
		const domain = packet.fromDomain || "unknown";
		const group = groups.get(domain) ?? {
			domain,
			count: 0,
			read: 0,
			unread: 0,
			unknown: 0,
		};
		group.count += 1;
		const isRead = message.read ?? message.isRead;
		if (isRead === true) {
			group.read += 1;
		} else if (isRead === false) {
			group.unread += 1;
		} else {
			group.unknown += 1;
		}
		groups.set(domain, group);
	}
	return [...groups.values()]
		.sort(
			(left, right) =>
				right.count - left.count || left.domain.localeCompare(right.domain),
		)
		.slice(0, limit);
}

function sortedCountMap(map: Map<string, number>): [string, number][] {
	return [...map.entries()].sort(
		(left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
	);
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

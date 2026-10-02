import { redactPublicValue, redactText } from "../privacy/redact";
import { workspaceDirForProfile } from "./profile";
import { basename, join, relative, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import pMap from "p-map";
import { redactInventoryRow } from "../privacy/inventory";
import type { AppConfig } from "../config/types";
import type {
	MailFolder,
	MailLabel,
	MailMessageSummary,
	MailProvider,
	MailProviderClient,
	MailRule,
} from "../providers/types";
import {
	readJsonFile,
	readJsonFileIfExists,
	writeJsonFile,
} from "../utils/json";
import {
	inferFilterNamingConventions,
	type FilterNamingConvention,
} from "./filter-naming";
import { folderDisplayName, resolveFolder } from "./folders";
import {
	createWriterPool,
	normalizeWriterCount,
	type WriterPool,
	type WriterPoolConfig,
} from "./writer-pool";
import type {
	ClassificationGuide,
	MessageDecision,
	MessagePipelineStatus,
	MessageStatusEntry,
	MessageStatusIndex,
	MessageWorkItem,
	WorkspaceLogin,
} from "./types";

const pipelineStatuses: MessagePipelineStatus[] = [
	"fetched",
	"exported",
	"classified",
	"planned",
	"dry_run",
	"applied",
	"skipped",
	"failed",
];

export type WorkspacePaths = {
	dir: string;
	login: string;
	folders: string;
	labels: string;
	filters: string;
	classificationGuide: string;
	messagesDir: string;
	status: string;
	plansDir: string;
	reportsDir: string;
	auditDir: string;
};

export function workspacePaths(
	dir = workspaceDirForProfile({ provider: "protonmail" }),
): WorkspacePaths {
	return {
		dir,
		login: join(dir, "login.json"),
		folders: join(dir, "folders.json"),
		labels: join(dir, "labels.json"),
		filters: join(dir, "filters.json"),
		classificationGuide: join(dir, "classification.json"),
		messagesDir: join(dir, "messages"),
		status: join(dir, "messages", "_status.json"),
		plansDir: join(dir, "plans"),
		reportsDir: join(dir, "reports"),
		auditDir: join(dir, "audit"),
	};
}

export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
	await Promise.all([
		Bun.$`mkdir -p ${paths.messagesDir}`.quiet(),
		Bun.$`mkdir -p ${paths.plansDir}`.quiet(),
		Bun.$`mkdir -p ${paths.reportsDir}`.quiet(),
		Bun.$`mkdir -p ${paths.auditDir}`.quiet(),
	]);
}

export async function writeLogin(
	paths: WorkspacePaths,
	config: AppConfig,
	username: string,
	options: { accountProfile?: string } = {},
): Promise<WorkspaceLogin> {
	await ensureWorkspace(paths);
	const now = new Date().toISOString();
	const existing = await readJsonFileIfExists<WorkspaceLogin>(paths.login);
	const login: WorkspaceLogin = {
		kind: "workspace-login",
		provider: config.provider,
		accountProfile: options.accountProfile || existing?.accountProfile,
		username,
		workspaceDir: paths.dir,
		sessionProfile: config.protonmail.sessionProfile,
		apiBaseUrl: config.protonmail.apiBaseUrl,
		liveBrowser: config.protonmail.liveBrowser,
		browserType: config.protonmail.browserType,
		browserHeadless: config.protonmail.browserHeadless,
		browserExecutablePath: config.protonmail.browserExecutablePath,
		gmailApiBaseUrl: config.gmail.apiBaseUrl,
		googleAuthMode: config.gmail.authMode,
		outlookGraphBaseUrl: config.outlook.graphBaseUrl,
		outlookAuthMode: config.outlook.authMode,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	await writeJsonFile(paths.login, login);
	return login;
}

export async function writeFolders(
	paths: WorkspacePaths,
	folders: MailFolder[],
	provider: MailProvider = "protonmail",
): Promise<void> {
	await ensureWorkspace(paths);
	await writeJsonFile(paths.folders, {
		kind: "folders",
		provider,
		createdAt: new Date().toISOString(),
		count: folders.length,
		folders,
	});
}

export async function writeLabels(
	paths: WorkspacePaths,
	labels: MailLabel[],
	provider: MailProvider = "protonmail",
): Promise<void> {
	await ensureWorkspace(paths);
	await writeJsonFile(paths.labels, {
		kind: "labels",
		provider,
		createdAt: new Date().toISOString(),
		count: labels.length,
		labels,
	});
}

export async function writeFilters(
	paths: WorkspacePaths,
	filters: MailRule[],
	snippetLength: number,
	provider: MailProvider = "protonmail",
): Promise<void> {
	await ensureWorkspace(paths);
	const folders = await readJsonFileIfExists<{ folders: MailFolder[] }>(
		paths.folders,
	);
	const redactedFilters = filters.map(
		(filter) => redactInventoryRow(filter, snippetLength) as MailRule,
	);
	await writeJsonFile(paths.filters, {
		kind: "filters",
		provider,
		createdAt: new Date().toISOString(),
		count: filters.length,
		filters: redactedFilters,
		namingConventions: inferFilterNamingConventions(
			redactedFilters,
			folders?.folders ?? [],
		),
	});
}

export async function readFolders(
	paths: WorkspacePaths,
): Promise<MailFolder[]> {
	const value = await readJsonFile<{ folders: MailFolder[] }>(paths.folders);
	return value.folders;
}

export async function readLabels(paths: WorkspacePaths): Promise<MailLabel[]> {
	const value = await readJsonFile<{ labels: MailLabel[] }>(paths.labels);
	return value.labels;
}

export async function readFilters(paths: WorkspacePaths): Promise<unknown[]> {
	const value = await readJsonFile<{ filters: unknown[] }>(paths.filters);
	return value.filters;
}

export async function readFilterNamingConventions(
	paths: WorkspacePaths,
): Promise<FilterNamingConvention[]> {
	const value = await readJsonFile<{
		namingConventions?: FilterNamingConvention[];
	}>(paths.filters);
	return Array.isArray(value.namingConventions) ? value.namingConventions : [];
}

export async function writeClassificationGuide(
	paths: WorkspacePaths,
): Promise<ClassificationGuide> {
	// Snapshots are optional for this informational guide: a missing `load folders`/
	// `load filters` step degrades to empty sections instead of aborting the pipeline.
	const [foldersSnapshot, filtersSnapshot] = await Promise.all([
		readJsonFileIfExists<{ folders?: unknown[] }>(paths.folders),
		readJsonFileIfExists<{ filters?: unknown[] }>(paths.filters),
	]);
	const folders = Array.isArray(foldersSnapshot?.folders)
		? foldersSnapshot.folders
		: [];
	const filters = Array.isArray(filtersSnapshot?.filters)
		? filtersSnapshot.filters
		: [];
	const guide: ClassificationGuide = {
		kind: "classification-guide",
		createdAt: new Date().toISOString(),
		modelGuidance:
			"Use the fastest/cheapest adequate model for sorting and summaries. Prefer Codex-local review; this CLI prepares redacted files and does not need to live as an autonomous classifier.",
		instructions: [
			"Read messages/_status.json to find pending message files.",
			"Open individual messages/*.json files as needed.",
			"Update each message file's decision field and move status from fetched/exported to classified, skipped, or failed.",
			"Use existing folders when possible. If no folder fits, mark action review and explain the folder gap.",
			"Set decision.markRead to true for handled inbox items so the review and dry-run plan records read-state intent.",
			"Explain why an existing filter did not already handle the message in decision.filterGap when relevant.",
			"Do not add raw email addresses, phone numbers, or full message bodies to decisions.",
		],
		allowedActions: ["move", "keep", "review", "skip"],
		folders: folders.map(redactPublicValue),
		filters: filters.map(redactPublicValue),
		messageStatusPath: relative(paths.dir, paths.status),
		messageFilesGlob: "messages/*.json",
	};
	await writeJsonFile(paths.classificationGuide, guide);
	return guide;
}

const DEFAULT_BATCH_CHUNK_SIZE = 50;
// Below this, worker startup + structured-clone overhead outweighs the parallel
// CPU win, so small batches (and the whole test suite) stay on the main thread.
const WORKER_MESSAGE_THRESHOLD = 256;

function defaultBatchWorkerCount(): number {
	const cores =
		typeof navigator !== "undefined" && navigator.hardwareConcurrency
			? navigator.hardwareConcurrency
			: 4;
	// Leave one core for the main thread's fetch/dispatch loop; cap so we don't
	// spawn a dozen threads for a workload that is partly I/O-bound anyway.
	return Math.max(1, Math.min(cores - 1, 8));
}

export async function writeMessageBatch(input: {
	paths: WorkspacePaths;
	folders: MailFolder[];
	messages: MailMessageSummary[];
	snippetLength: number;
	concurrency?: number;
	provider?: MailProvider;
	workers?: number;
	workerThreshold?: number;
}): Promise<MessageStatusIndex> {
	return runBatchWrite({
		paths: input.paths,
		folders: input.folders,
		snippetLength: input.snippetLength,
		provider: input.provider,
		pages: singleMessagePage(input.messages),
		workers: input.workers,
		workerThreshold: input.workerThreshold,
	});
}

/**
 * Streaming batch writer: consumes provider pages as they arrive and hands each
 * chunk to the writer pool, overlapping network pagination with redaction and
 * disk writes. Only a bounded window of chunks is ever in flight, so peak RAM
 * stays flat no matter how large the mailbox is — no full-mailbox array, and
 * only the compact status entries are retained for the index.
 */
export async function writeMessageBatchStream(input: {
	paths: WorkspacePaths;
	folders: MailFolder[];
	pages: AsyncIterable<MailMessageSummary[]>;
	snippetLength: number;
	provider?: MailProvider;
	workers?: number;
	chunkSize?: number;
	workerThreshold?: number;
}): Promise<MessageStatusIndex> {
	return runBatchWrite(input);
}

async function* singleMessagePage(
	messages: MailMessageSummary[],
): AsyncGenerator<MailMessageSummary[]> {
	if (messages.length > 0) {
		yield messages;
	}
}

async function runBatchWrite(input: {
	paths: WorkspacePaths;
	folders: MailFolder[];
	pages: AsyncIterable<MailMessageSummary[]>;
	snippetLength: number;
	provider?: MailProvider;
	workers?: number;
	chunkSize?: number;
	workerThreshold?: number;
}): Promise<MessageStatusIndex> {
	await ensureWorkspace(input.paths);
	await clearMessageWorkItems(input.paths);

	const maxWorkers = normalizeWriterCount(
		input.workers ?? defaultBatchWorkerCount(),
	);
	const chunkSize = input.chunkSize ?? DEFAULT_BATCH_CHUNK_SIZE;
	const workerThreshold = input.workerThreshold ?? WORKER_MESSAGE_THRESHOLD;
	const config: WriterPoolConfig = {
		folderNames: input.folders.map((folder) => folder.name),
		snippetLength: input.snippetLength,
		// One timestamp for the whole batch: cheaper than a syscall per message and
		// keeps the fetched-at marker consistent across the run.
		nowIso: new Date().toISOString(),
		messagesDirAbs: resolve(input.paths.messagesDir),
	};

	const inline = createWriterPool(1, config);
	let pool: WriterPool | undefined;
	const entries: MessageStatusEntry[] = [];
	const inflight = new Set<Promise<void>>();
	let failed = false;
	let failure: unknown;
	const checkFailure = () => {
		if (failed) throw failure;
	};
	const maxInflight = maxWorkers + 2;
	let seen = 0;

	try {
		for await (const page of input.pages) {
			checkFailure();
			for (let offset = 0; offset < page.length; offset += chunkSize) {
				checkFailure();
				const chunk = page.slice(offset, offset + chunkSize);
				seen += chunk.length;
				if (!pool && maxWorkers > 1 && seen > workerThreshold) {
					pool = createWriterPool(maxWorkers, config);
				}
				if (pool) {
					const settled = pool.process(chunk).then(
						(chunkEntries) => {
							for (const entry of chunkEntries) entries.push(entry);
						},
						(error) => {
							if (!failed) {
								failed = true;
								failure = error;
							}
						},
					);
					const tracked = settled.finally(() => {
						inflight.delete(tracked);
					});
					inflight.add(tracked);
					// Backpressure: never let more than a bounded window of chunks be in
					// flight, so peak memory is O(workers × chunk), not O(mailbox).
					if (inflight.size >= maxInflight) {
						await Promise.race(inflight);
						checkFailure();
					}
				} else {
					for (const entry of await inline.process(chunk)) {
						entries.push(entry);
					}
				}
			}
		}
		await Promise.all(inflight);
		checkFailure();
	} finally {
		// allSettled first so a failed run's remaining writes don't surface as
		// unhandled rejections, then tear down worker threads.
		await Promise.allSettled(inflight);
		await Promise.all([inline.close(), pool?.close() ?? Promise.resolve()]);
	}

	const status = statusIndexFromEntries(entries, input.provider);
	await writeJsonFile(input.paths.status, status);
	return status;
}

function statusIndexFromEntries(
	entries: MessageStatusEntry[],
	provider?: MailProvider,
): MessageStatusIndex {
	const counts = Object.fromEntries(
		pipelineStatuses.map((status) => [status, 0]),
	) as Record<MessagePipelineStatus, number>;
	for (const entry of entries) {
		counts[entry.status] += 1;
	}
	const now = new Date().toISOString();
	return {
		kind: "message-status-index",
		provider: provider ?? "protonmail",
		createdAt: now,
		updatedAt: now,
		total: entries.length,
		counts,
		items: entries,
	};
}

async function clearMessageWorkItems(paths: WorkspacePaths): Promise<void> {
	// A fresh batch reflects only the current fetch; otherwise message files
	// from prior batches (renamed folders, re-fetched ranges) pile up forever.
	if (existsSync(paths.messagesDir)) {
		await rm(paths.messagesDir, { recursive: true, force: true });
	}
	await Bun.$`mkdir -p ${paths.messagesDir}`.quiet();
}

export async function readMessageStatus(
	paths: WorkspacePaths,
): Promise<MessageStatusIndex> {
	return readJsonFile<MessageStatusIndex>(paths.status);
}

export async function readMessageWorkItems(
	paths: WorkspacePaths,
	concurrency = 50,
): Promise<MessageWorkItem[]> {
	const status = await readMessageStatus(paths);
	return pMap(
		status.items,
		(item) => readJsonFile<MessageWorkItem>(join(paths.dir, item.file)),
		{ concurrency: boundedConcurrency(concurrency) },
	);
}

export async function writeMessageWorkItems(
	paths: WorkspacePaths,
	items: MessageWorkItem[],
): Promise<MessageStatusIndex> {
	await ensureWorkspace(paths);
	await pMap(items, (item) => writeJsonFile(join(paths.dir, item.file), item), {
		concurrency: 50,
	});
	const status = createStatusIndex(items);
	await writeJsonFile(paths.status, status);
	return status;
}

export async function updateMessageDecisions(
	paths: WorkspacePaths,
	updates: Map<string, MessageDecision>,
): Promise<{ matched: number; written: number; status: MessageStatusIndex }> {
	const items = await readMessageWorkItems(paths);
	const now = new Date().toISOString();
	let written = 0;
	for (const item of items) {
		const decision = updates.get(item.id);
		if (!decision) {
			continue;
		}
		item.decision = decision;
		item.status = "classified";
		item.statusUpdatedAt = now;
		written += 1;
	}
	const status = await writeMessageWorkItems(paths, items);
	return { matched: updates.size, written, status };
}

export async function writeReviewPlan(paths: WorkspacePaths): Promise<unknown> {
	const items = await readMessageWorkItems(paths);
	const eligibleItems = mutationEligibleItems(items);
	const countsByFolder = new Map<string, number>();
	const needsFolder = eligibleItems.filter(
		(item) => item.decision?.action === "review",
	);
	const readyToMove = eligibleItems.filter(
		(item) => item.decision?.action === "move" && item.decision.targetFolder,
	);
	const readyToMarkRead = eligibleItems.filter(
		(item) => item.decision?.markRead === true,
	);
	for (const item of readyToMove) {
		const target = item.decision?.targetFolder ?? "";
		countsByFolder.set(target, (countsByFolder.get(target) ?? 0) + 1);
	}

	const review = {
		kind: "workspace-review",
		createdAt: new Date().toISOString(),
		total: items.length,
		eligible: eligibleItems.length,
		readyToMove: readyToMove.length,
		readyToMarkRead: readyToMarkRead.length,
		needsReview: needsFolder.length,
		folderRecommendations: needsFolder.map((item) => ({
			messageFile: item.file,
			reason: item.decision?.reason ?? "No existing folder selected.",
		})),
		filterRecommendations: Array.from(countsByFolder.entries()).map(
			([targetFolder, count]) => ({
				targetFolder,
				count,
				recommendation: `Review a provider filter for messages now routed to ${targetFolder}.`,
				automaticApply: false,
			}),
		),
	};
	await writeJsonFile(join(paths.plansDir, "review.json"), review);
	return review;
}

export async function dryRunWorkspaceApply(
	paths: WorkspacePaths,
): Promise<unknown> {
	const items = await readMessageWorkItems(paths);
	const eligibleItems = mutationEligibleItems(items);
	const ready = eligibleItems.filter(
		(item) => item.decision?.action === "move" && item.decision.targetFolder,
	);
	const markRead = eligibleItems.filter(
		(item) => item.decision?.markRead === true,
	);
	const review = eligibleItems.filter(
		(item) => item.decision?.action === "review",
	);
	const skipped = eligibleItems.filter(
		(item) =>
			item.decision?.action === "skip" || item.decision?.action === "keep",
	);
	const planFingerprint = applyPlanFingerprint(eligibleItems);
	const summary = {
		kind: "workspace-apply-summary",
		dryRun: true,
		mutated: false,
		createdAt: new Date().toISOString(),
		total: items.length,
		eligible: eligibleItems.length,
		ready: ready.length,
		markRead: markRead.length,
		review: review.length,
		skipped: skipped.length,
		planFingerprint,
		warning: "Dry run only. No mailbox mutation was performed.",
	};
	await writeJsonFile(join(paths.reportsDir, "dry-run.json"), summary);
	return summary;
}

export async function applyWorkspaceMutations(
	paths: WorkspacePaths,
	client: MailProviderClient,
): Promise<unknown> {
	await ensureWorkspace(paths);
	const [folders, items] = await Promise.all([
		readFolders(paths),
		readMessageWorkItems(paths),
	]);
	const eligibleItems = mutationEligibleItems(items);
	await assertDryRunMatches(paths, eligibleItems);
	const ready = eligibleItems.filter(
		(item) => item.decision?.action === "move" && item.decision.targetFolder,
	);
	const markRead = eligibleItems.filter(
		(item) => item.decision?.markRead === true,
	);
	const review = eligibleItems.filter(
		(item) => item.decision?.action === "review",
	);
	const skipped = eligibleItems.filter(
		(item) =>
			item.decision?.action === "skip" || item.decision?.action === "keep",
	);
	const movesByFolder = new Map<
		string,
		{ folder: MailFolder; items: MessageWorkItem[] }
	>();

	for (const item of ready) {
		const target = item.decision?.targetFolder ?? "";
		const folder = resolveFolder(folders, target, { purpose: "target" });
		const existing = movesByFolder.get(folder.id) ?? { folder, items: [] };
		existing.items.push(item);
		movesByFolder.set(folder.id, existing);
	}

	for (const move of movesByFolder.values()) {
		await client.moveMessages({
			messageIds: move.items.map((item) => item.sourceMessageId),
			targetFolderId: move.folder.id,
		});
	}

	const unlabelsBySourceFolder = new Map<string, MessageWorkItem[]>();
	for (const item of ready) {
		const target = item.decision?.targetFolder ?? "";
		const targetFolder = resolveFolder(folders, target, { purpose: "target" });
		const sourceFolder = resolveFolder(folders, item.currentFolder, {
			purpose: "source",
		});
		if (sourceFolder.id === targetFolder.id) {
			continue;
		}
		const existing = unlabelsBySourceFolder.get(sourceFolder.id) ?? [];
		existing.push(item);
		unlabelsBySourceFolder.set(sourceFolder.id, existing);
	}

	if (
		!client.unlabelMessages &&
		client.provider !== "outlook" &&
		unlabelsBySourceFolder.size > 0
	) {
		throw new Error(
			`${client.provider} apply cannot remove source labels with this client`,
		);
	}

	for (const [labelId, itemsToUnlabel] of unlabelsBySourceFolder.entries()) {
		await client.unlabelMessages?.({
			messageIds: itemsToUnlabel.map((item) => item.sourceMessageId),
			labelId,
		});
	}

	if (markRead.length > 0) {
		await client.markMessagesRead({
			messageIds: markRead.map((item) => item.sourceMessageId),
		});
	}

	const now = new Date().toISOString();
	for (const item of [...ready, ...markRead]) {
		item.status = "applied";
		item.statusUpdatedAt = now;
		const target = item.decision?.targetFolder;
		if (target) {
			const folder = resolveFolder(folders, target, { purpose: "target" });
			item.currentFolder = folderDisplayName(folder);
			item.packet.currentFolder = redactText(folderDisplayName(folder));
		}
		await writeJsonFile(join(paths.dir, item.file), item);
	}

	const allItems = await readMessageWorkItems(paths);
	const status = createStatusIndex(allItems);
	status.updatedAt = now;
	await writeJsonFile(paths.status, status);

	const auditPath = join(
		paths.auditDir,
		`apply-${now.replace(/[:.]/g, "-")}.json`,
	);
	const audit = {
		kind: "workspace-apply-audit",
		provider: client.provider,
		createdAt: now,
		dryRun: false,
		mutated: true,
		moved: ready.map((item) => ({
			id: item.id,
			sourceIdHash: item.sourceIdHash,
			targetFolder: item.decision?.targetFolder,
		})),
		markedRead: markRead.map((item) => ({
			id: item.id,
			sourceIdHash: item.sourceIdHash,
		})),
	};
	await writeJsonFile(auditPath, audit);

	const summary = {
		kind: "workspace-apply-summary",
		provider: client.provider,
		dryRun: false,
		mutated: true,
		total: items.length,
		eligible: eligibleItems.length,
		moved: ready.length,
		markRead: markRead.length,
		review: review.length,
		skipped: skipped.length,
		auditPath,
	};
	await writeJsonFile(join(paths.reportsDir, "apply.json"), summary);
	return summary;
}

export async function cleanupWorkspace(
	paths: WorkspacePaths,
): Promise<string[]> {
	const targets = [
		paths.folders,
		paths.filters,
		paths.classificationGuide,
		paths.messagesDir,
		paths.plansDir,
		paths.reportsDir,
		paths.auditDir,
	];
	const deleted: string[] = [];
	await Promise.all(
		targets.map(async (target) => {
			if (!existsSync(target)) {
				return;
			}
			await rm(target, { recursive: true, force: true });
			deleted.push(target);
		}),
	);
	return deleted;
}

export function cleanupWarning(paths: WorkspacePaths): string {
	return [
		"WARNING: cleanup deletes local workspace artifacts.",
		`Will delete: ${[
			basename(paths.folders),
			basename(paths.filters),
			basename(paths.classificationGuide),
			"messages/",
			"plans/",
			"reports/",
			"audit/",
		].join(", ")}`,
		`Will preserve: ${relative(paths.dir, paths.login)}`,
	].join(" ");
}

function createStatusIndex(items: MessageWorkItem[]): MessageStatusIndex {
	const counts = Object.fromEntries(
		pipelineStatuses.map((status) => [status, 0]),
	) as Record<MessagePipelineStatus, number>;
	for (const item of items) {
		counts[item.status] += 1;
	}
	const now = new Date().toISOString();
	return {
		kind: "message-status-index",
		createdAt: now,
		updatedAt: now,
		total: items.length,
		counts,
		items: items.map((item) => ({
			id: item.id,
			file: item.file,
			status: item.status,
			statusUpdatedAt: item.statusUpdatedAt,
			currentFolder: item.currentFolder,
			fromDomain: item.packet.fromDomain,
			subject: item.packet.subject,
			decision: item.decision,
			error: item.error,
		})),
	};
}

async function assertDryRunMatches(
	paths: WorkspacePaths,
	items: MessageWorkItem[],
): Promise<void> {
	const reportPath = join(paths.reportsDir, "dry-run.json");
	const dryRun = await readJsonFileIfExists<{
		dryRun?: boolean;
		planFingerprint?: string;
	}>(reportPath);
	if (!dryRun?.dryRun || !dryRun.planFingerprint) {
		throw new Error(
			"apply --confirm requires a successful apply --dry-run report for the current mailbox workspace",
		);
	}
	const currentFingerprint = applyPlanFingerprint(items);
	if (dryRun.planFingerprint !== currentFingerprint) {
		throw new Error(
			"apply --confirm refused because the mailbox plan changed after the last dry run; run apply --dry-run again",
		);
	}
}

function mutationEligibleItems(items: MessageWorkItem[]): MessageWorkItem[] {
	return items.filter((item) => item.status !== "applied");
}

function applyPlanFingerprint(items: MessageWorkItem[]): string {
	const stablePlan = items
		.map((item) => ({
			id: item.id,
			sourceIdHash: item.sourceIdHash,
			status: item.status,
			action: item.decision?.action,
			targetFolder: item.decision?.targetFolder,
			markRead: item.decision?.markRead === true,
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	return createHash("sha256").update(JSON.stringify(stablePlan)).digest("hex");
}

function boundedConcurrency(value = 50): number {
	return Math.max(1, Math.floor(value));
}

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getBooleanFlag, getNumberFlag, getStringFlag } from "../cli/args";
import type { CliContext } from "../cli/context";
import { printJson } from "../cli/output";

import { packetForMessage } from "../classifier/packets";
import { inboxRuntimeFor } from "../runtime";
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
import { createBridgeImapSession } from "../protonmail/bridge-adapter";
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
		const snippetLength = providerSnippetLength(
			context.config,
			client.provider,
		);
		await writeFilters(paths, filters, snippetLength, client.provider);
		printJson({
			kind: "workspace-load-filters",
			provider: client.provider,
			out: paths.filters,
			count: filters.length,
			redacted: true,
			snippetLength,
			note: "conditions and actions in filters.json are redacted snippets and can cut a rule off mid-string. filters extend reads the live rule for a full before/after diff.",
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
		modelHint: `Use the fastest/cheapest adequate model for sorting and summaries. Default configured model: ${context.config.classifier.model}. Prefer local model review for this CLI.`,
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
				"Created one redacted file per message for model-assisted cleanup.",
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
	const legacyToSelector = getStringFlag(context.args.flags, "to");
	if (legacyToSelector) {
		console.error("warning: --to on folders relocate is deprecated; use --dest");
	}
	const destSelector = getStringFlag(context.args.flags, "dest") || legacyToSelector;
	const rename = getStringFlag(context.args.flags, "rename");
	if (!destSelector && !rename) {
		throw new Error(
			"folders relocate requires --dest <parent|root> and/or --rename <name>",
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
		if (destSelector) {
			const destinationId =
				destSelector.toLowerCase() === "root"
					? "msgfolderroot"
					: resolveFolder(folders, destSelector, { purpose: "target" }).id;
			await client.moveFolder({ id: source.id, destinationId });
			movedTo = destSelector;
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
		omittedCount?: number;
		omitted?: unknown[];
		replacedCount?: number;
		replacedDecisions?: unknown[];
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
			omittedCount: review.omittedCount,
			omitted: review.omitted,
			replacedCount: review.replacedCount,
			replacedDecisions: review.replacedDecisions,
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
	const session = await protonSessionStatus(context);
	const bridge = await bridgeHealthStatus(context);
	const bridgeField = bridge ? { bridge } : {};
	if (getBooleanFlag(context.args.flags, "full")) {
		printJson({ ...status, session, ...bridgeField });
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
		session,
		...bridgeField,
	});
}

type BridgeHealthStatus = {
	checked: boolean;
	ok?: boolean;
	check?: string;
	detail?: string;
	bridgeCertPinned?: boolean;
};

function bridgeCheckNameFor(detail: string): string {
	if (/not reachable/.test(detail)) return "unreachable";
	if (/fingerprint does not match/.test(detail)) return "tls-mismatch";
	return "imap-login";
}

/** `undefined` when the profile is not a Bridge-configured protonmail one; `checked:false` in fixture mode. */
async function bridgeHealthStatus(context: CliContext): Promise<BridgeHealthStatus | undefined> {
	if (context.config.provider !== "protonmail") return undefined;
	const { runtime, profile: profileName } = inboxRuntimeFor(context.config);
	const profile = await runtime.profileGet?.(profileName);
	const bridge = profile?.protonmail;
	if (!bridge?.bridgeUsername) return undefined;
	const bridgeCertPinned = Boolean(bridge.bridgeCertFingerprint);
	if (context.config.mail.dataPath) {
		return { checked: false, bridgeCertPinned };
	}
	const credentialName = `inbox/protonmail-bridge/${accountProfileSlug(profileName)}`;
	const password = await runtime.credentialGet?.(credentialName);
	if (!password) {
		return {
			checked: true,
			ok: false,
			check: "no-credential",
			detail: `store the Proton Bridge password first: dg-skills credentials set ${credentialName}`,
			bridgeCertPinned,
		};
	}
	try {
		const session = await createBridgeImapSession({
			host: bridge.bridgeHost ?? "127.0.0.1",
			imapPort: bridge.bridgeImapPort ?? 1143,
			smtpPort: bridge.bridgeSmtpPort ?? 1025,
			username: bridge.bridgeUsername,
			password,
			certFingerprint: bridge.bridgeCertFingerprint,
			credentialName,
		});
		await session.close();
		return { checked: true, ok: true, check: "imap-login", bridgeCertPinned };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { checked: true, ok: false, check: bridgeCheckNameFor(detail), detail, bridgeCertPinned };
	}
}

async function protonSessionStatus(context: CliContext): Promise<{
	checked: boolean;
	ok?: boolean;
	check?: string;
	detail?: string;
}> {
	const request = inboxRuntimeFor(context.config).runtime.browserRequest;
	if (!request) {
		return {
			checked: false,
			detail:
				"Pass --session ID to check the extension peer, the mail.proton.me/u/N tab, and x-pm-uid. Local message counts are still reported.",
		};
	}
	try {
		await request({ operation: "session-status" });
		return { checked: true, ok: true, check: "x-pm-uid-observed" };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			checked: true,
			ok: false,
			check: sessionCheckName(detail),
			detail,
		};
	}
}

function sessionCheckName(detail: string): string {
	if (/no extension peer/i.test(detail)) return "no-peer";
	if (/mail tab navigated away/i.test(detail)) return "mail-tab-navigated";
	if (/missing x-pm-uid/i.test(detail)) return "missing-x-pm-uid";
	if (/no proton mail tab matching/i.test(detail)) return "no-tab";
	if (/no proton mail tab/i.test(detail)) return "no-tab";
	return "session-error";
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
		const snapshotFile = await readJsonIfExists<{ createdAt?: string }>(
			paths.folders,
		);
		let countsFrom: "live" | "snapshot" = "snapshot";
		let liveTotal = resolvedFolder.total;
		let liveUnread = resolvedFolder.unread;
		try {
			const liveFolders = await client.listFolders();
			const live = liveFolders.find((item) => item.id === resolvedFolder.id);
			if (live) {
				countsFrom = "live";
				liveTotal = live.total;
				liveUnread = live.unread;
				await writeFolders(paths, liveFolders, client.provider);
			}
		} catch {
			countsFrom = "snapshot";
		}
		const snapshotStale =
			countsFrom !== "live" ||
			resolvedFolder.total !== liveTotal ||
			resolvedFolder.unread !== liveUnread;
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
				total: liveTotal,
				unread: liveUnread,
				countsFrom,
				snapshotTotal: resolvedFolder.total,
				snapshotUnread: resolvedFolder.unread,
				snapshotAt: snapshotFile?.createdAt,
				snapshotStale,
			},
			limit,
			fetched: messages.length,
			reachedLimit: messages.length >= limit,
			readState: countReadState(messages),
			topDomains: groupByDomain(packets, groupLimit),
			warning: snapshotStale
				? "Read-only folder probe. snapshotTotal and snapshotUnread are the saved load-folders counts and are stale. total and unread are live when countsFrom is live. readState counts only the messages fetched for this probe. No messages were changed."
				: "Read-only folder probe. Folder totals were refreshed from the provider and match the saved snapshot. readState counts only the messages fetched for this probe. No messages were changed.",
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

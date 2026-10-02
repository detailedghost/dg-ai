import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nanoid } from "nanoid";
import { sortBy, uniqBy } from "lodash-es";
import { getBooleanFlag, getNumberFlag, getStringFlag } from "../../cli/args";
import type { CliContext } from "../../cli/context";
import { printJson } from "../../cli/output";
import {
	providerBatchSize,
	providerSnippetLength,
} from "../../providers/factory";
import type {
	MailDataset,
	MailFolder,
	MailMessageSummary,
	MailProvider,
	MailRule,
} from "../../providers/types";
import {
	readJsonFile,
	readJsonFileIfExists,
	stringifyJson,
	writeJsonFile,
} from "../../utils/json";
import { folderPath, normalizeFolderSelector } from "../../workspace/folders";
import { workspaceDirForProfile } from "../../workspace/profile";
import {
	readFilters,
	readFolders,
	readMessageWorkItems,
	workspacePaths,
	writeFilters,
	writeFolders,
	writeLabels,
	writeMessageWorkItems,
} from "../../workspace/store";

type OutlookLabel = {
	id: string;
	name: string;
	usage?: number;
};

type OutlookMessage = MailMessageSummary & {
	labels?: string[];
	categories?: string[];
};

type OutlookDataset = MailDataset & {
	labels?: OutlookLabel[];
	categories?: OutlookLabel[];
};

type FolderAction =
	| {
			action: "create";
			pathSegments: string[];
			displayPath: string;
			name: string;
			parentDisplayPath?: string;
	  }
	| { action: "reuse"; pathSegments: string[]; displayPath: string; id: string }
	| {
			action: "move";
			fromPath: string;
			toSegments: string[];
			toDisplayPath: string;
			id: string;
			name: string;
	  };

type FolderTreePlan = {
	kind: "mailbox-folder-tree-plan";
	provider: MailProvider;
	dryRun: boolean;
	mutated: boolean;
	mutationTarget: string;
	dir: string;
	actions: FolderAction[];
	planFingerprint: string;
	warning?: string;
	auditPath?: string;
};

type LabelAction =
	| { action: "create"; name: string }
	| { action: "keep"; name: string; id?: string }
	| { action: "rename"; from: string; to: string; id: string }
	| { action: "delete"; name: string; id: string; usage: number }
	| {
			action: "refuse-delete";
			name: string;
			id: string;
			usage: number;
			reason: string;
	  };

type LabelPlan = {
	kind: "mailbox-label-plan";
	provider: MailProvider;
	dryRun: boolean;
	mutated: boolean;
	mutationTarget: string;
	dir: string;
	actions: LabelAction[];
	planFingerprint: string;
	warning?: string;
	auditPath?: string;
};

type OutlookFilterRule = {
	name: string;
	targetSegments: string[];
	labelNames?: string[];
	subjectContains: string[];
	fromContains?: string[];
	priority: number;
	reason: string;
};

type FilterAction = {
	action: "create" | "update";
	name: string;
	targetDisplayPath: string;
	targetSegments: string[];
	labelNames: string[];
	subjectContains: string[];
	fromContains: string[];
	priority: number;
	estimatedMessages: number;
	existingFilterId?: string;
};

type FilterPlan = {
	kind: "mailbox-filter-plan";
	provider: MailProvider;
	dryRun: boolean;
	mutated: boolean;
	mutationTarget: string;
	dir: string;
	actions: FilterAction[];
	refusedRules: { reason: string; domain: string }[];
	planFingerprint: string;
	warning?: string;
	auditPath?: string;
};

type RouteAction = {
	messageId: string;
	targetSegments: string[];
	targetDisplayPath: string;
	labelNames: string[];
	read: boolean;
	markRead: boolean;
	reason: string;
};

type RouteSkip = {
	messageId: string;
	read: boolean;
	reason: string;
};

type RoutePlan = {
	kind: "mailbox-inbox-route-plan";
	provider: MailProvider;
	dryRun: boolean;
	mutated: boolean;
	mutationTarget: string;
	dir: string;
	scanned: number;
	route: RouteAction[];
	skip: RouteSkip[];
	planFingerprint: string;
	warning?: string;
	auditPath?: string;
};

type OutlookCleanupPlan = {
	kind?: "mailbox-cleanup-policy" | "outlook-cleanup-plan";
	folders: {
		topLevel: string[];
		children: { parentSegments: string[]; names: string[] }[];
		legacyMoves: { fromPath: string; toSegments: string[] }[];
		systemFolderNames?: string[];
	};
	labels: {
		keep: string[];
		create: string[];
		delete: { name: string; allowUsed?: boolean }[];
		usedDeleteRefusalReason: string;
	};
	filters: {
		refusedDomains: string[];
		refusedDomainReason: string;
		rules: OutlookFilterRule[];
	};
	routing: {
		lowRiskReasons: string[];
		unmatchedReason: string;
		reviewOnlyRules: {
			keywords: string[];
			targetSegments: string[];
			labelNames?: string[];
			reason: string;
		}[];
	};
	verification?: {
		legacyRoots?: string[];
		deletedLabelsAbsent?: string[];
		systemFolderNames?: string[];
	};
	artifacts: {
		mutationTarget: string;
		compactRoutePlans?: boolean;
	};
};

type CleanupPatchOperation =
	| { op: "set"; path: string[]; value: unknown }
	| { op: "append"; path: string[]; value: unknown }
	| { op: "remove"; path: string[]; value?: unknown };

type CleanupPatch = {
	kind?: "mailbox-cleanup-plan-patch";
	operations: CleanupPatchOperation[];
};

type CleanupReviewVerdict = "approve" | "reject";

type CleanupReviewPayload = {
	kind: "mailbox-cleanup-plan-review";
	provider: MailProvider;
	dir: string;
	mutationTarget: string;
	verdict: CleanupReviewVerdict;
	comment: string;
	sectionComments: { section: string; comment: string }[];
	patch: CleanupPatch;
	submittedAt: string;
};

type CleanupReviewExpectation = {
	provider: MailProvider;
	dir: string;
	mutationTarget: string;
	hasVerificationFailures: boolean;
};

type RemadeCleanupPlans = {
	remadeAt: string;
	folderPlanPath: string;
	folderDryRunPath: string;
	labelPlanPath: string;
	labelDryRunPath: string;
	filterPlanPath: string;
	filterDryRunPath: string;
	routePlanPath: string;
	routeDryRunPath: string;
};

export async function planOutlookFolderTree(
	context: CliContext,
): Promise<void> {
	assertMode(context, "folders plan-tree", "dry-run");
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const folders = await loadFolderSnapshot(context, paths);
	const plan = buildFolderTreePlan(
		context.config.provider,
		paths.dir,
		folders,
		true,
		cleanupPlan,
	);
	await writeJsonFile(
		join(paths.plansDir, providerFileName(context, "folder-tree-plan")),
		plan,
	);
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "folder-tree-dry-run")),
		summarizeFolderTreePlan(plan),
	);
	printJson(summarizeFolderTreePlan(plan));
}

export async function applyOutlookFolderTree(
	context: CliContext,
): Promise<void> {
	assertMode(context, "folders apply-tree", "confirm");
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const plan = buildFolderTreePlan(
		context.config.provider,
		paths.dir,
		dataset.folders,
		false,
		cleanupPlan,
	);
	await assertMatchingDryRun(
		paths.reportsDir,
		providerFileName(context, "folder-tree-dry-run"),
		plan.planFingerprint,
		"folders apply-tree",
	);
	applyFolderActions(dataset, plan.actions);
	const auditPath = await writeDatasetAndAudit(
		context,
		dataset,
		paths.dir,
		providerFileStem(context, "folder-tree"),
		{ ...plan, mutated: true },
	);
	await writeFolders(paths, dataset.folders, context.config.provider);
	const summary = summarizeFolderTreePlan({
		...plan,
		mutated: true,
		auditPath,
	});
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "folder-tree")),
		summary,
	);
	printJson(summary);
}

export async function planOutlookLabels(context: CliContext): Promise<void> {
	assertMode(context, "labels plan", "dry-run");
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const plan = buildLabelPlan(
		context.config.provider,
		paths.dir,
		dataset,
		true,
		cleanupPlan,
	);
	await writeJsonFile(
		join(paths.plansDir, providerFileName(context, "label-plan")),
		plan,
	);
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "label-dry-run")),
		summarizeLabelPlan(plan),
	);
	printJson(summarizeLabelPlan(plan));
}

export async function applyOutlookLabels(context: CliContext): Promise<void> {
	assertMode(context, "labels apply", "confirm");
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const plan = buildLabelPlan(
		context.config.provider,
		paths.dir,
		dataset,
		false,
		cleanupPlan,
	);
	await assertMatchingDryRun(
		paths.reportsDir,
		providerFileName(context, "label-dry-run"),
		plan.planFingerprint,
		"labels apply",
	);
	applyLabelActions(dataset, plan.actions);
	const auditPath = await writeDatasetAndAudit(
		context,
		dataset,
		paths.dir,
		providerFileStem(context, "label"),
		{ ...plan, mutated: true },
	);
	await writeLabels(paths, currentLabels(dataset), context.config.provider);
	const summary = summarizeLabelPlan({ ...plan, mutated: true, auditPath });
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "label")),
		summary,
	);
	printJson(summary);
}

export async function planOutlookFilters(context: CliContext): Promise<void> {
	assertMode(context, "filters plan", "dry-run");
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const plan = buildFilterPlan(
		context.config.provider,
		paths.dir,
		dataset,
		true,
		cleanupPlan,
	);
	await writeJsonFile(
		join(paths.plansDir, providerFileName(context, "filter-plan")),
		plan,
	);
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "filter-dry-run")),
		summarizeFilterPlan(plan),
	);
	printJson(summarizeFilterPlan(plan));
}

export async function applyOutlookFilters(context: CliContext): Promise<void> {
	assertMode(context, "filters apply", "confirm");
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const plan = buildFilterPlan(
		context.config.provider,
		paths.dir,
		dataset,
		false,
		cleanupPlan,
	);
	await assertMatchingDryRun(
		paths.reportsDir,
		providerFileName(context, "filter-dry-run"),
		plan.planFingerprint,
		"filters apply",
	);
	applyFilterActions(dataset, plan.actions);
	const auditPath = await writeDatasetAndAudit(
		context,
		dataset,
		paths.dir,
		providerFileStem(context, "filter"),
		{ ...plan, mutated: true },
	);
	await writeFilters(
		paths,
		dataset.filters ?? [],
		providerSnippetLength(context.config, context.config.provider),
		context.config.provider,
	);
	const summary = summarizeFilterPlan({ ...plan, mutated: true, auditPath });
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "filter")),
		summary,
	);
	printJson(summary);
}

export async function planOutlookInboxRoutes(
	context: CliContext,
): Promise<void> {
	assertMode(context, "inbox route-plan", "dry-run");
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const limit = getNumberFlag(
		context.args.flags,
		"limit",
		providerBatchSize(context.config, context.config.provider),
	);
	const plan = buildRoutePlan(
		context.config.provider,
		paths.dir,
		dataset,
		true,
		limit,
		cleanupPlan,
	);
	await writeJsonFile(
		join(paths.plansDir, providerFileName(context, "inbox-route-plan")),
		compactRoutePlanForStorage(plan, cleanupPlan),
	);
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "inbox-route-dry-run")),
		summarizeRoutePlan(plan),
	);
	printJson(summarizeRoutePlan(plan));
}

export async function applyOutlookInboxRoutes(
	context: CliContext,
): Promise<void> {
	assertMode(context, "inbox route-apply", "confirm");
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const limit = getNumberFlag(
		context.args.flags,
		"limit",
		providerBatchSize(context.config, context.config.provider),
	);
	const plan = buildRoutePlan(
		context.config.provider,
		paths.dir,
		dataset,
		false,
		limit,
		cleanupPlan,
	);
	await assertMatchingDryRun(
		paths.reportsDir,
		providerFileName(context, "inbox-route-dry-run"),
		plan.planFingerprint,
		"inbox route-apply",
	);
	applyRouteActions(dataset, plan.route);
	const auditPath = await writeDatasetAndAudit(
		context,
		dataset,
		paths.dir,
		providerFileStem(context, "inbox-route"),
		{ ...plan, mutated: true },
	);
	await syncRouteWorkItems(context, paths, plan.route);
	const summary = summarizeRoutePlan({ ...plan, mutated: true, auditPath });
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "inbox-route")),
		summary,
	);
	printJson(summary);
}

export async function verifyCleanupPolicy(context: CliContext): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const findings = await buildVerificationFindings(
		context,
		paths,
		dataset,
		cleanupPlan,
	);
	const failed = findings.filter((finding) => finding.status === "fail").length;
	const warning = findings.filter(
		(finding) => finding.status === "warn",
	).length;
	const summary = {
		kind: "mailbox-cleanup-verification",
		provider: context.config.provider,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		dir: paths.dir,
		failed,
		warning,
		passed: findings.filter((finding) => finding.status === "pass").length,
		findings,
	};
	await writeJsonFile(
		join(paths.reportsDir, providerFileName(context, "cleanup-verify")),
		summary,
	);
	printJson(summary);
	if (failed > 0) {
		throw new Error(
			`Cleanup verification failed with ${failed} failing check(s)`,
		);
	}
}

export async function validateCleanupPolicy(
	context: CliContext,
): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const planPath = cleanupPlanPath(context, paths);
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const summary = {
		kind: "mailbox-cleanup-policy-validation",
		provider: context.config.provider,
		valid: true,
		dir: paths.dir,
		planPath,
		folders:
			cleanupPlan.folders.topLevel.length +
			cleanupPlan.folders.children.reduce(
				(total, group) => total + group.names.length,
				0,
			),
		labelCreates: cleanupPlan.labels.create.length,
		labelDeletes: cleanupPlan.labels.delete.length,
		filterRules: cleanupPlan.filters.rules.length,
		reviewOnlyRules: cleanupPlan.routing.reviewOnlyRules.length,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
	};
	printJson(summary);
}

export async function visualizeCleanupPolicy(
	context: CliContext,
): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const payload = await buildCleanupVisualizationPayload(
		context,
		paths,
		cleanupPlan,
	);
	const verificationFailed = Number(payload.summary.verificationFailed ?? 0);
	const payloadPath = join(
		paths.reportsDir,
		providerFileName(context, "cleanup-visualization"),
	);
	const htmlPath = join(
		paths.reportsDir,
		`${providerFileStem(context, "cleanup-visualization")}.html`,
	);
	const reviewPath = join(
		paths.reportsDir,
		providerFileName(context, "cleanup-review"),
	);
	await writeJsonFile(payloadPath, payload);
	await Bun.write(htmlPath, renderCleanupVisualizationHtml(payload));
	const noOpen = getBooleanFlag(context.args.flags, "no-open");
	const noWait = getBooleanFlag(context.args.flags, "no-wait");
	const summary = {
		kind: "mailbox-cleanup-visualization-summary",
		provider: context.config.provider,
		dir: paths.dir,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		payloadPath,
		htmlPath,
		sections: Object.keys(payload.sections),
		patchKind: payload.patchContract.kind,
	};
	if (noWait) {
		const browserUrl = pathToFileURL(resolve(htmlPath)).href;
		const opened = noOpen ? false : await openBrowser(browserUrl);
		printJson({
			...summary,
			browserUrl,
			reviewUrl: browserUrl,
			opened,
			waiting: false,
		});
		return;
	}

	const reviewServer = await startCleanupReviewServer({
		html: renderCleanupVisualizationHtml(payload),
		reviewPath,
		expectation: {
			provider: context.config.provider,
			dir: paths.dir,
			mutationTarget: cleanupPlan.artifacts.mutationTarget,
			hasVerificationFailures: verificationFailed > 0,
		},
		timeoutSeconds: getNumberFlag(
			context.args.flags,
			"review-timeout",
			30 * 60,
		),
	});
	const opened = noOpen ? false : await openBrowser(reviewServer.reviewUrl);
	printJson({
		kind: "mailbox-cleanup-review-waiting",
		provider: context.config.provider,
		dir: paths.dir,
		reviewUrl: reviewServer.reviewUrl,
		reviewPath,
		htmlPath,
		opened,
		timeoutSeconds: reviewServer.timeoutSeconds,
	});
	let review: CleanupReviewPayload;
	try {
		review = await reviewServer.review;
	} finally {
		reviewServer.stop();
	}
	const patchPath = join(
		paths.reportsDir,
		providerFileName(context, "cleanup-review-patch"),
	);
	const patchOperations = review.patch.operations.length;
	if (patchOperations > 0) {
		await writeJsonFile(patchPath, review.patch);
	}
	const remadePlans = await remakeCleanupDryRunPlans(
		context,
		paths,
		cleanupPlan,
	);
	const refreshedPayload = await buildCleanupVisualizationPayload(
		context,
		paths,
		cleanupPlan,
	);
	await writeJsonFile(payloadPath, refreshedPayload);
	await Bun.write(htmlPath, renderCleanupVisualizationHtml(refreshedPayload));
	const reviewSummary = {
		kind: "mailbox-cleanup-review-summary",
		provider: context.config.provider,
		dir: paths.dir,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		verdict: review.verdict,
		comment: review.comment,
		sectionComments: review.sectionComments.length,
		patchOperations,
		reviewPath,
		patchPath: patchOperations > 0 ? patchPath : undefined,
		submittedAt: review.submittedAt,
		remadeAt: remadePlans.remadeAt,
		remadePlanPaths: [
			remadePlans.folderPlanPath,
			remadePlans.labelPlanPath,
			remadePlans.filterPlanPath,
			remadePlans.routePlanPath,
		],
		remadeDryRunPaths: [
			remadePlans.folderDryRunPath,
			remadePlans.labelDryRunPath,
			remadePlans.filterDryRunPath,
			remadePlans.routeDryRunPath,
		],
		refreshedPayloadPath: payloadPath,
		refreshedHtmlPath: htmlPath,
		nextDryRunCommand:
			review.verdict === "approve"
				? `dg-skills inbox apply --provider ${context.config.provider} --dir ${shellQuote(paths.dir)} --dry-run`
				: undefined,
		nextApplyCommand:
			review.verdict === "approve"
				? `dg-skills inbox apply --provider ${context.config.provider} --dir ${shellQuote(paths.dir)} --confirm`
				: undefined,
		planPatchCommand:
			review.verdict === "reject" && patchOperations > 0
				? `dg-skills inbox cleanup plan-patch --provider ${context.config.provider} --dir ${shellQuote(paths.dir)} --patch-path ${shellQuote(patchPath)}`
				: undefined,
	};
	printJson(reviewSummary);
	if (review.verdict === "reject") {
		throw new Error("Cleanup review rejected");
	}
}

export async function applyCleanupPlanPatch(
	context: CliContext,
): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const planPath = cleanupPlanPath(context, paths);
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const patchPath = getStringFlag(context.args.flags, "patch-path");
	if (!patchPath) {
		throw new Error("cleanup plan-patch requires --patch-path");
	}
	const patch = await readJsonFile<CleanupPatch>(patchPath);
	validateCleanupPatch(patch, patchPath);
	const nextPlan = applyPatchOperations(cleanupPlan, patch.operations);
	validateCleanupPlan(nextPlan, planPath);
	const summary = {
		kind: "mailbox-cleanup-plan-patch-summary",
		provider: context.config.provider,
		dir: paths.dir,
		planPath,
		patchPath,
		operations: patch.operations.length,
		changed: fingerprint(cleanupPlan) !== fingerprint(nextPlan),
		dryRun: !getBooleanFlag(context.args.flags, "confirm"),
	};
	if (!getBooleanFlag(context.args.flags, "confirm")) {
		printJson(summary);
		return;
	}
	await writeJsonFile(planPath, nextPlan);
	printJson({ ...summary, dryRun: false, mutated: true });
}

export async function exportInboxReviewQueue(
	context: CliContext,
): Promise<void> {
	const paths = workspacePaths(getWorkspaceDir(context));
	const cleanupPlan = await loadCleanupPlan(context, paths);
	const dataset = await readOutlookDataset(context);
	const routeReport = await readJsonFileIfExists<{ skips?: RouteSkip[] }>(
		join(paths.reportsDir, providerFileName(context, "inbox-route")),
	);
	const skips = routeReport?.skips ?? [];
	const messages = new Map(
		(dataset.messages as OutlookMessage[]).map((message) => [
			message.id,
			message,
		]),
	);
	const groups = new Map<string, unknown[]>();
	for (const skip of skips) {
		const message = messages.get(skip.messageId);
		const row = {
			messageId: skip.messageId,
			read: skip.read,
			reason: skip.reason,
			senderDomainHash: message
				? hashText(domainFromSender(message.from))
				: undefined,
			labels: [
				...new Set([
					...(message?.labels ?? []),
					...(message?.categories ?? []),
				]),
			].sort(),
		};
		const group = groups.get(skip.reason) ?? [];
		group.push(row);
		groups.set(skip.reason, group);
	}
	const queue = {
		kind: "mailbox-inbox-review-queue",
		provider: context.config.provider,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		dir: paths.dir,
		total: skips.length,
		groups: Object.fromEntries(
			[...groups.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	};
	const reportPath = join(
		paths.reportsDir,
		providerFileName(context, "inbox-review-queue"),
	);
	await writeJsonFile(reportPath, queue);
	printJson({
		kind: "mailbox-inbox-review-queue-summary",
		provider: context.config.provider,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		dir: paths.dir,
		total: skips.length,
		reportPath,
		groups: Object.fromEntries(
			[...groups.entries()]
				.map(([reason, rows]) => [reason, rows.length] as const)
				.sort(([left], [right]) => left.localeCompare(right)),
		),
	});
}

function buildFolderTreePlan(
	provider: MailProvider,
	dir: string,
	folders: MailFolder[],
	dryRun: boolean,
	cleanupPlan: OutlookCleanupPlan,
): FolderTreePlan {
	const actions: FolderAction[] = [];
	const working = folders.map((folder) => ({ ...folder }));
	const legacyFolderMoves = new Map(
		cleanupPlan.folders.legacyMoves.map((move) => [
			move.fromPath,
			move.toSegments,
		]),
	);
	for (const folder of working) {
		const moveTo = legacyFolderMoves.get(folderPath(folder));
		if (!moveTo) {
			continue;
		}
		assertFolderSegments(moveTo);
		actions.push({
			action: "move",
			fromPath: folderPath(folder),
			toSegments: moveTo,
			toDisplayPath: displayPath(moveTo),
			id: folder.id,
			name: last(moveTo),
		});
		folder.path = pathKey(moveTo);
		folder.name = last(moveTo);
		folder.parentId = undefined;
	}

	for (const name of cleanupPlan.folders.topLevel) {
		ensureFolderAction(working, [name], actions);
	}
	for (const group of cleanupPlan.folders.children) {
		for (const child of group.names) {
			ensureFolderAction(working, [...group.parentSegments, child], actions);
		}
	}
	const uniqueActions = uniqBy(
		actions,
		(action) =>
			`${action.action}:${"displayPath" in action ? action.displayPath : action.toDisplayPath}`,
	);
	const planWithoutFingerprint = {
		kind: "mailbox-folder-tree-plan" as const,
		provider,
		dryRun,
		mutated: false,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		dir,
		actions: uniqueActions,
		warning: dryRun
			? "Dry run only. No mailbox folders were changed."
			: undefined,
	};
	return {
		...planWithoutFingerprint,
		planFingerprint: fingerprint({
			actions: stableFolderActions(uniqueActions),
		}),
	};
}

function ensureFolderAction(
	working: MailFolder[],
	segments: string[],
	actions: FolderAction[],
): void {
	assertFolderSegments(segments);
	const display = displayPath(segments);
	const existing = findFolderBySegments(working, segments);
	if (existing) {
		actions.push({
			action: "reuse",
			pathSegments: segments,
			displayPath: display,
			id: existing.id,
		});
		return;
	}
	const parentSegments = segments.slice(0, -1);
	const parent =
		parentSegments.length > 0
			? findFolderBySegments(working, parentSegments)
			: undefined;
	actions.push({
		action: "create",
		pathSegments: segments,
		displayPath: display,
		name: last(segments),
		parentDisplayPath:
			parentSegments.length > 0 ? displayPath(parentSegments) : undefined,
	});
	working.push({
		id: `planned:${pathKey(segments)}`,
		name: last(segments),
		path: pathKey(segments),
		type: "folder",
		parentId: parent?.id,
	});
}

function buildLabelPlan(
	provider: MailProvider,
	dir: string,
	dataset: OutlookDataset,
	dryRun: boolean,
	cleanupPlan: OutlookCleanupPlan,
): LabelPlan {
	const labels = currentLabels(dataset);
	const actions: LabelAction[] = [];
	for (const name of cleanupPlan.labels.keep) {
		const existing = findLabel(labels, name);
		if (existing) {
			actions.push({ action: "keep", name, id: existing.id });
		}
	}
	for (const name of cleanupPlan.labels.create) {
		if (!findLabel(labels, name)) {
			actions.push({ action: "create", name });
		}
	}
	for (const deleteRule of cleanupPlan.labels.delete) {
		const name = deleteRule.name;
		const label = findLabel(labels, name);
		if (label) {
			const usage = labelUsage(dataset, label.name, label.usage);
			actions.push(
				usage === 0 || deleteRule.allowUsed
					? { action: "delete", name: label.name, id: label.id, usage }
					: {
							action: "refuse-delete",
							name: label.name,
							id: label.id,
							usage,
							reason: cleanupPlan.labels.usedDeleteRefusalReason,
						},
			);
		}
	}
	const planWithoutFingerprint = {
		kind: "mailbox-label-plan" as const,
		provider,
		dryRun,
		mutated: false,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		dir,
		actions,
		warning: dryRun
			? "Dry run only. No mailbox labels were changed."
			: undefined,
	};
	return {
		...planWithoutFingerprint,
		planFingerprint: fingerprint({ actions }),
	};
}

function buildFilterPlan(
	provider: MailProvider,
	dir: string,
	dataset: OutlookDataset,
	dryRun: boolean,
	cleanupPlan: OutlookCleanupPlan,
): FilterPlan {
	const messages = dataset.messages as OutlookMessage[];
	const filters = dataset.filters ?? [];
	const actions = cleanupPlan.filters.rules.map((rule) => {
		const existing = filters.find(
			(filter) => normalize(filter.name) === normalize(rule.name),
		);
		const fromContains = rule.fromContains ?? [];
		return {
			action: existing ? ("update" as const) : ("create" as const),
			name: rule.name,
			targetDisplayPath: displayPath(rule.targetSegments),
			targetSegments: rule.targetSegments,
			labelNames: rule.labelNames ?? [],
			subjectContains: rule.subjectContains,
			fromContains,
			priority: rule.priority,
			estimatedMessages: messages.filter((message) =>
				matchesRule(message, rule),
			).length,
			existingFilterId: existing?.id,
		};
	});
	const planWithoutFingerprint = {
		kind: "mailbox-filter-plan" as const,
		provider,
		dryRun,
		mutated: false,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		dir,
		actions,
		refusedRules: cleanupPlan.filters.refusedDomains.map((domain) => ({
			domain,
			reason: cleanupPlan.filters.refusedDomainReason,
		})),
		warning: dryRun
			? "Dry run only. No mailbox rules were changed."
			: undefined,
	};
	return {
		...planWithoutFingerprint,
		planFingerprint: fingerprint({
			actions,
			refusedRules: planWithoutFingerprint.refusedRules,
		}),
	};
}

function buildRoutePlan(
	provider: MailProvider,
	dir: string,
	dataset: OutlookDataset,
	dryRun: boolean,
	limit: number,
	cleanupPlan: OutlookCleanupPlan,
): RoutePlan {
	const inboxMessages = (dataset.messages as OutlookMessage[])
		.filter(
			(message) =>
				normalizeFolderSelector(message.folderName ?? message.folderId) ===
				"inbox",
		)
		.slice(0, limit);
	const route: RouteAction[] = [];
	const skip: RouteSkip[] = [];
	const lowRiskReasons = new Set(cleanupPlan.routing.lowRiskReasons);
	for (const message of inboxMessages) {
		const decision = routeMessage(message, cleanupPlan);
		const read = message.read === true;
		if (!decision) {
			skip.push({
				messageId: message.id,
				read,
				reason: cleanupPlan.routing.unmatchedReason,
			});
			continue;
		}
		if (decision.reviewOnly) {
			skip.push({ messageId: message.id, read, reason: decision.reason });
			continue;
		}
		route.push({
			messageId: message.id,
			targetSegments: decision.targetSegments,
			targetDisplayPath: displayPath(decision.targetSegments),
			labelNames: decision.labelNames ?? [],
			read,
			markRead: lowRiskReasons.has(decision.reason),
			reason: decision.reason,
		});
	}
	const planWithoutFingerprint = {
		kind: "mailbox-inbox-route-plan" as const,
		provider,
		dryRun,
		mutated: false,
		mutationTarget: cleanupPlan.artifacts.mutationTarget,
		dir,
		scanned: inboxMessages.length,
		route,
		skip,
		warning: dryRun
			? "Dry run only. No Inbox messages were moved or marked read."
			: undefined,
	};
	return {
		...planWithoutFingerprint,
		planFingerprint: fingerprint({
			scanned: planWithoutFingerprint.scanned,
			route,
			skip,
		}),
	};
}

function applyFolderActions(
	dataset: OutlookDataset,
	actions: FolderAction[],
): void {
	for (const action of actions) {
		if (action.action === "reuse") {
			continue;
		}
		if (action.action === "move") {
			const folder = dataset.folders.find((item) => item.id === action.id);
			if (!folder) {
				throw new Error(
					`Mailbox folder not found for migration: ${action.fromPath}`,
				);
			}
			folder.name = action.name;
			folder.path = pathKey(action.toSegments);
			folder.parentId = undefined;
			for (const message of dataset.messages) {
				if (message.folderId === folder.id) {
					message.folderName = folder.name;
				}
			}
			continue;
		}
		const parent =
			action.pathSegments.length > 1
				? findFolderBySegments(
						dataset.folders,
						action.pathSegments.slice(0, -1),
					)
				: undefined;
		dataset.folders.push({
			id: `outlook-folder-${nanoid()}`,
			name: action.name,
			path: pathKey(action.pathSegments),
			parentId: parent?.id,
			type: "folder",
			total: 0,
			unread: 0,
		});
	}
}

function applyLabelActions(
	dataset: OutlookDataset,
	actions: LabelAction[],
): void {
	const labels = currentLabels(dataset);
	for (const action of actions) {
		if (action.action === "keep" || action.action === "refuse-delete") {
			continue;
		}
		if (action.action === "create") {
			labels.push({
				id: `outlook-label-${nanoid()}`,
				name: action.name,
				usage: 0,
			});
			continue;
		}
		if (action.action === "rename") {
			const label = labels.find((item) => item.id === action.id);
			if (label) {
				label.name = action.to;
			}
			renameMessageLabel(dataset, action.from, action.to);
			continue;
		}
		const index = labels.findIndex((item) => item.id === action.id);
		if (index >= 0) {
			labels.splice(index, 1);
		}
		removeMessageLabel(dataset, action.name);
	}
	dataset.labels = labels;
	dataset.categories = labels;
}

function applyFilterActions(
	dataset: OutlookDataset,
	actions: FilterAction[],
): void {
	dataset.filters ??= [];
	for (const action of actions) {
		const filter = {
			id: action.existingFilterId ?? `outlook-filter-${nanoid()}`,
			name: action.name,
			enabled: true,
			conditions: [
				JSON.stringify({
					subjectContains: action.subjectContains,
					fromContains: action.fromContains,
					priority: action.priority,
				}),
			],
			actions: [
				JSON.stringify({
					moveTo: action.targetDisplayPath,
					labels: action.labelNames,
				}),
			],
		} satisfies MailRule;
		const index = dataset.filters.findIndex(
			(item) =>
				item.id === filter.id ||
				normalize(item.name) === normalize(filter.name),
		);
		if (index >= 0) {
			dataset.filters[index] = filter;
		} else {
			dataset.filters.push(filter);
		}
	}
}

function applyRouteActions(
	dataset: OutlookDataset,
	actions: RouteAction[],
): void {
	for (const action of actions) {
		const folder = findFolderBySegments(dataset.folders, action.targetSegments);
		if (!folder) {
			throw new Error(
				`Mailbox target folder missing for route: ${action.targetDisplayPath}`,
			);
		}
		const message = (dataset.messages as OutlookMessage[]).find(
			(item) => item.id === action.messageId,
		);
		if (!message) {
			continue;
		}
		message.folderId = folder.id;
		message.folderName = folder.name;
		if (action.markRead) {
			message.read = true;
		}
		const labels = new Set([
			...(message.labels ?? []),
			...(message.categories ?? []),
		]);
		for (const label of action.labelNames) {
			labels.add(label);
		}
		message.labels = [...labels].sort();
		message.categories = message.labels;
	}
}

async function syncRouteWorkItems(
	context: CliContext,
	paths: ReturnType<typeof workspacePaths>,
	actions: RouteAction[],
): Promise<void> {
	if (
		getOutlookDataPath(context) ||
		!existsSync(paths.status) ||
		actions.length === 0
	) {
		return;
	}
	const actionsByMessageId = new Map(
		actions.map((action) => [action.messageId, action]),
	);
	const items = await readMessageWorkItems(paths);
	const now = new Date().toISOString();
	for (const item of items) {
		const action = actionsByMessageId.get(item.id);
		if (!action) {
			continue;
		}
		item.status = "applied";
		item.statusUpdatedAt = now;
		item.currentFolder = action.targetDisplayPath;
		item.packet.currentFolder = action.targetDisplayPath;
		item.decision = {
			action: "move",
			targetFolder: action.targetDisplayPath,
			markRead: action.markRead,
			reason: action.reason,
		};
	}
	await writeMessageWorkItems(paths, items);
}

function routeMessage(
	message: OutlookMessage,
	cleanupPlan: OutlookCleanupPlan,
):
	| {
			targetSegments: string[];
			labelNames?: string[];
			reason: string;
			reviewOnly?: boolean;
	  }
	| undefined {
	const text =
		`${message.subject} ${message.from} ${message.senderName ?? ""}`.toLowerCase();
	for (const rule of cleanupPlan.routing.reviewOnlyRules) {
		if (hasAny(text, rule.keywords)) {
			return {
				targetSegments: rule.targetSegments,
				labelNames: rule.labelNames,
				reason: rule.reason,
				reviewOnly: true,
			};
		}
	}
	for (const rule of cleanupPlan.filters.rules) {
		if (matchesRule(message, rule)) {
			return {
				targetSegments: rule.targetSegments,
				labelNames: rule.labelNames,
				reason: rule.reason,
			};
		}
	}
	return undefined;
}

function matchesRule(
	message: OutlookMessage,
	rule: OutlookFilterRule,
): boolean {
	const subject = message.subject.toLowerCase();
	const from = message.from.toLowerCase();
	const subjectMatch = rule.subjectContains.some((value) =>
		subject.includes(value),
	);
	const fromMatch = (rule.fromContains ?? []).some((value) =>
		from.includes(value),
	);
	if (rule.fromContains && rule.fromContains.length > 0) {
		return subjectMatch || fromMatch;
	}
	return subjectMatch || hasAny(from, rule.subjectContains);
}

function summarizeFolderTreePlan(plan: FolderTreePlan): unknown {
	return {
		kind: "mailbox-folder-tree-summary",
		provider: plan.provider,
		dryRun: plan.dryRun,
		mutated: plan.mutated,
		mutationTarget: plan.mutationTarget,
		dir: plan.dir,
		create: plan.actions.filter((action) => action.action === "create").length,
		move: plan.actions.filter((action) => action.action === "move").length,
		reuse: plan.actions.filter((action) => action.action === "reuse").length,
		folders: plan.actions,
		planFingerprint: plan.planFingerprint,
		warning: plan.warning,
		auditPath: plan.auditPath,
	};
}

function summarizeLabelPlan(plan: LabelPlan): unknown {
	return {
		kind: "mailbox-label-summary",
		provider: plan.provider,
		dryRun: plan.dryRun,
		mutated: plan.mutated,
		mutationTarget: plan.mutationTarget,
		dir: plan.dir,
		create: plan.actions.filter((action) => action.action === "create").length,
		keep: plan.actions.filter((action) => action.action === "keep").length,
		rename: plan.actions.filter((action) => action.action === "rename").length,
		delete: plan.actions.filter((action) => action.action === "delete").length,
		refusedDelete: plan.actions.filter(
			(action) => action.action === "refuse-delete",
		).length,
		actions: plan.actions,
		planFingerprint: plan.planFingerprint,
		warning: plan.warning,
		auditPath: plan.auditPath,
	};
}

function summarizeFilterPlan(plan: FilterPlan): unknown {
	return {
		kind: "mailbox-filter-summary",
		provider: plan.provider,
		dryRun: plan.dryRun,
		mutated: plan.mutated,
		mutationTarget: plan.mutationTarget,
		dir: plan.dir,
		create: plan.actions.filter((action) => action.action === "create").length,
		update: plan.actions.filter((action) => action.action === "update").length,
		refusedRules: plan.refusedRules,
		actions: plan.actions,
		planFingerprint: plan.planFingerprint,
		warning: plan.warning,
		auditPath: plan.auditPath,
	};
}

function summarizeRoutePlan(plan: RoutePlan): unknown {
	const destinationCounts = new Map<
		string,
		{ total: number; read: number; unread: number }
	>();
	for (const action of plan.route) {
		const row = destinationCounts.get(action.targetDisplayPath) ?? {
			total: 0,
			read: 0,
			unread: 0,
		};
		row.total += 1;
		if (action.read) {
			row.read += 1;
		} else {
			row.unread += 1;
		}
		destinationCounts.set(action.targetDisplayPath, row);
	}
	return {
		kind: "mailbox-inbox-route-summary",
		provider: plan.provider,
		dryRun: plan.dryRun,
		mutated: plan.mutated,
		mutationTarget: plan.mutationTarget,
		dir: plan.dir,
		scanned: plan.scanned,
		route: plan.route.length,
		skip: plan.skip.length,
		destinationCounts: Object.fromEntries(
			[...destinationCounts.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
		reviewSkips: plan.skip.filter((skip) => skip.reason.includes("review"))
			.length,
		actions: plan.route,
		skips: plan.skip,
		planFingerprint: plan.planFingerprint,
		warning: plan.warning,
		auditPath: plan.auditPath,
	};
}

async function loadFolderSnapshot(
	context: CliContext,
	paths: ReturnType<typeof workspacePaths>,
): Promise<MailFolder[]> {
	if (existsSync(paths.folders)) {
		return readFolders(paths);
	}
	return (await readOutlookDataset(context)).folders;
}

async function loadCleanupPlan(
	context: CliContext,
	paths: ReturnType<typeof workspacePaths>,
): Promise<OutlookCleanupPlan> {
	const planPath = cleanupPlanPath(context, paths);
	const plan = await readJsonFileIfExists<OutlookCleanupPlan>(planPath);
	if (!plan) {
		throw new Error(
			`No cleanup policy plan found at ${planPath}. cleanup validate/visualize check a provider cleanup-policy plan — create one with the folders/labels/filters plan commands or pass --plan-path <file>. The redacted move workflow (batch -> suggest -> review -> apply) does not require one.`,
		);
	}
	validateCleanupPlan(plan, planPath);
	return plan;
}

function cleanupPlanPath(
	context: CliContext,
	paths: ReturnType<typeof workspacePaths>,
): string {
	return getStringFlag(
		context.args.flags,
		"plan-path",
		join(paths.plansDir, "cleanup-policy.json"),
	);
}

function validateCleanupPlan(plan: OutlookCleanupPlan, planPath: string): void {
	if (
		!Array.isArray(plan.folders?.topLevel) ||
		!Array.isArray(plan.folders?.children) ||
		!Array.isArray(plan.folders?.legacyMoves)
	) {
		throw new Error(
			`Invalid Outlook cleanup plan folders section: ${planPath}`,
		);
	}
	if (
		!Array.isArray(plan.labels?.keep) ||
		!Array.isArray(plan.labels?.create) ||
		!Array.isArray(plan.labels?.delete)
	) {
		throw new Error(`Invalid Outlook cleanup plan labels section: ${planPath}`);
	}
	if (
		typeof plan.labels.usedDeleteRefusalReason !== "string" ||
		plan.labels.usedDeleteRefusalReason.trim() === ""
	) {
		throw new Error(`Invalid cleanup plan label refusal reason: ${planPath}`);
	}
	if (
		!Array.isArray(plan.filters?.rules) ||
		!Array.isArray(plan.filters?.refusedDomains)
	) {
		throw new Error(
			`Invalid Outlook cleanup plan filters section: ${planPath}`,
		);
	}
	if (
		typeof plan.filters.refusedDomainReason !== "string" ||
		plan.filters.refusedDomainReason.trim() === ""
	) {
		throw new Error(`Invalid cleanup plan refused-domain reason: ${planPath}`);
	}
	if (
		plan.filters.rules.some(
			(rule) => typeof rule.reason !== "string" || rule.reason.trim() === "",
		)
	) {
		throw new Error(`Invalid Outlook cleanup plan rule reason: ${planPath}`);
	}
	if (
		!Array.isArray(plan.routing?.lowRiskReasons) ||
		!Array.isArray(plan.routing?.reviewOnlyRules)
	) {
		throw new Error(
			`Invalid Outlook cleanup plan routing section: ${planPath}`,
		);
	}
	if (
		typeof plan.routing.unmatchedReason !== "string" ||
		plan.routing.unmatchedReason.trim() === ""
	) {
		throw new Error(`Invalid cleanup plan unmatched route reason: ${planPath}`);
	}
	if (
		plan.routing.reviewOnlyRules.some(
			(rule) => typeof rule.reason !== "string" || rule.reason.trim() === "",
		)
	) {
		throw new Error(`Invalid cleanup plan review-only reason: ${planPath}`);
	}
	if (
		typeof plan.artifacts?.mutationTarget !== "string" ||
		plan.artifacts.mutationTarget.trim() === ""
	) {
		throw new Error(
			`Invalid cleanup plan artifact mutation target: ${planPath}`,
		);
	}
}

async function readOutlookDataset(
	context: CliContext,
): Promise<OutlookDataset> {
	const dataPath = getOutlookDataPath(context);
	if (!dataPath) {
		return readOutlookWorkspaceDataset(
			workspacePaths(getWorkspaceDir(context)),
		);
	}
	return readJsonFile<OutlookDataset>(dataPath);
}

async function writeOutlookDataset(
	context: CliContext,
	dataset: OutlookDataset,
): Promise<void> {
	const dataPath = getOutlookDataPath(context);
	if (!dataPath) {
		await writeJsonFile(
			join(getWorkspaceDir(context), "outlook-dataset-local-apply.json"),
			dataset,
		);
		return;
	}
	await Bun.write(dataPath, stringifyJson(dataset));
}

async function readOutlookWorkspaceDataset(
	paths: ReturnType<typeof workspacePaths>,
): Promise<OutlookDataset> {
	const [folders, filters, labelsSnapshot, status] = await Promise.all([
		readFolders(paths),
		readFilters(paths),
		readJsonFileIfExists<{
			labels?: OutlookLabel[];
			categories?: OutlookLabel[];
		}>(join(paths.dir, "labels.json")),
		readJsonFileIfExists<{
			kind?: string;
			items?: {
				id: string;
				fromDomain?: string;
				subject?: string;
				currentFolder?: string;
			}[];
		}>(paths.status),
	]);
	const inbox = folders.find(
		(folder) =>
			normalizeFolderSelector(folder.name) === "inbox" ||
			(folder as { aliases?: string[] }).aliases?.includes("inbox"),
	);
	const folderById = new Map(folders.map((folder) => [folder.id, folder]));
	const messages = (status?.items ?? []).map((item) => {
		const folder = item.currentFolder
			? folderById.get(item.currentFolder)
			: undefined;
		return {
			id: item.id,
			from: item.fromDomain ?? "",
			subject: item.subject ?? "",
			snippet: "",
			folderId: item.currentFolder ?? folder?.id ?? inbox?.id ?? "Inbox",
			folderName:
				folder?.name ??
				(item.currentFolder === inbox?.id
					? "Inbox"
					: item.currentFolder ?? "Inbox"),
			read: false,
		} satisfies OutlookMessage;
	});
	return {
		folders,
		filters: normalizeWorkspaceFilters(filters),
		labels: labelsSnapshot?.labels ?? labelsSnapshot?.categories ?? [],
		categories: labelsSnapshot?.categories ?? labelsSnapshot?.labels ?? [],
		messages,
	};
}

async function writeDatasetAndAudit(
	context: CliContext,
	dataset: OutlookDataset,
	dir: string,
	name: string,
	value: unknown,
): Promise<string> {
	await writeOutlookDataset(context, dataset);
	const auditPath = join(
		dir,
		"audit",
		`${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	await writeJsonFile(auditPath, value);
	return auditPath;
}

async function assertMatchingDryRun(
	reportsDir: string,
	fileName: string,
	fingerprintValue: string,
	commandName: string,
): Promise<void> {
	const report = await readJsonFileIfExists<{
		dryRun?: boolean;
		planFingerprint?: string;
	}>(join(reportsDir, fileName));
	if (!report?.dryRun || report.planFingerprint !== fingerprintValue) {
		throw new Error(
			`${commandName} --confirm requires a matching dry-run report and unchanged plan fingerprint`,
		);
	}
}

function assertOutlookProvider(context: CliContext): void {
	const provider = getStringFlag(context.args.flags, "provider");
	if (provider !== "outlook") {
		throw new Error("Outlook cleanup commands require --provider outlook");
	}
}

function assertMode(
	context: CliContext,
	commandName: string,
	expected: "dry-run" | "confirm",
): void {
	const dryRun = getBooleanFlag(context.args.flags, "dry-run");
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	if (dryRun && confirm) {
		throw new Error(
			`${commandName} accepts either --dry-run or --confirm, not both`,
		);
	}
	if (expected === "dry-run" && !dryRun) {
		throw new Error(`${commandName} requires --dry-run`);
	}
	if (expected === "confirm" && !confirm) {
		throw new Error(`${commandName} requires --confirm`);
	}
}

function currentLabels(dataset: OutlookDataset): OutlookLabel[] {
	const labels = dataset.labels ?? dataset.categories ?? [];
	dataset.labels = labels;
	dataset.categories = labels;
	return labels;
}

function findLabel(
	labels: OutlookLabel[],
	name: string,
): OutlookLabel | undefined {
	return labels.find((label) => normalize(label.name) === normalize(name));
}

function labelUsage(
	dataset: OutlookDataset,
	name: string,
	fallback?: number,
): number {
	const fromMessages = (dataset.messages as OutlookMessage[]).filter(
		(message) => {
			const labels = [...(message.labels ?? []), ...(message.categories ?? [])];
			return labels.some((label) => normalize(label) === normalize(name));
		},
	).length;
	return fromMessages || fallback || 0;
}

function renameMessageLabel(
	dataset: OutlookDataset,
	from: string,
	to: string,
): void {
	for (const message of dataset.messages as OutlookMessage[]) {
		if (message.labels) {
			message.labels = message.labels.map((label) =>
				normalize(label) === normalize(from) ? to : label,
			);
		}
		if (message.categories) {
			message.categories = message.categories.map((label) =>
				normalize(label) === normalize(from) ? to : label,
			);
		}
	}
}

function removeMessageLabel(dataset: OutlookDataset, name: string): void {
	for (const message of dataset.messages as OutlookMessage[]) {
		if (message.labels) {
			message.labels = message.labels.filter(
				(label) => normalize(label) !== normalize(name),
			);
		}
		if (message.categories) {
			message.categories = message.categories.filter(
				(label) => normalize(label) !== normalize(name),
			);
		}
	}
}

function findFolderBySegments(
	folders: MailFolder[],
	segments: string[],
): MailFolder | undefined {
	const key = normalizeFolderSelector(pathKey(segments));
	return folders.find(
		(folder) => normalizeFolderSelector(folderPath(folder)) === key,
	);
}

function assertFolderSegments(segments: string[]): void {
	for (const segment of segments) {
		if (segment.includes("/")) {
			throw new Error(
				`Mailbox folder display names must not contain "/": ${segment}`,
			);
		}
	}
}

function stableFolderActions(actions: FolderAction[]): unknown[] {
	return sortBy(
		actions.map((action) => {
			if (action.action === "move") {
				return {
					action: action.action,
					fromPath: action.fromPath,
					toDisplayPath: action.toDisplayPath,
					id: action.id,
				};
			}
			return {
				action: action.action,
				displayPath: action.displayPath,
				id: "id" in action ? action.id : undefined,
			};
		}),
		(item) => JSON.stringify(item),
	);
}

function getWorkspaceDir(context: CliContext): string {
	return workspaceDirForProfile({
		provider: context.config.provider,
		explicitDir: getStringFlag(context.args.flags, "dir"),
		accountProfile: getStringFlag(context.args.flags, "account-profile"),
	});
}

function getOutlookDataPath(context: CliContext): string | undefined {
	return typeof context.args.flags["data-path"] === "string"
		? context.args.flags["data-path"]
		: undefined;
}

async function buildVerificationFindings(
	context: CliContext,
	paths: ReturnType<typeof workspacePaths>,
	dataset: OutlookDataset,
	cleanupPlan: OutlookCleanupPlan,
): Promise<
	{ status: "pass" | "fail" | "warn"; check: string; detail: string }[]
> {
	const findings: {
		status: "pass" | "fail" | "warn";
		check: string;
		detail: string;
	}[] = [];
	const labels = currentLabels(dataset);
	const labelNames = new Set(labels.map((label) => normalize(label.name)));
	const deletedLabels =
		cleanupPlan.verification?.deletedLabelsAbsent ??
		cleanupPlan.labels.delete.map((rule) => rule.name);
	for (const name of deletedLabels) {
		const present = labelNames.has(normalize(name));
		const messageRefs = (dataset.messages as OutlookMessage[]).filter(
			(message) => messageHasLabel(message, name),
		).length;
		findings.push({
			status: present || messageRefs > 0 ? "fail" : "pass",
			check: "deleted-label-absent",
			detail: `${name}: labels=${present ? 1 : 0}, messageRefs=${messageRefs}`,
		});
	}

	for (const move of cleanupPlan.folders.legacyMoves) {
		const source = dataset.folders.find(
			(folder) =>
				normalizeFolderSelector(folderPath(folder)) ===
				normalizeFolderSelector(move.fromPath),
		);
		const target = findFolderBySegments(dataset.folders, move.toSegments);
		findings.push({
			status: source || !target ? "fail" : "pass",
			check: "legacy-folder-moved",
			detail: `${move.fromPath} -> ${displayPath(move.toSegments)}`,
		});
	}

	const legacyRoots = cleanupPlan.verification?.legacyRoots ?? [];
	for (const root of legacyRoots) {
		const rootFolder = dataset.folders.find(
			(folder) =>
				normalizeFolderSelector(folderPath(folder)) ===
				normalizeFolderSelector(root),
		);
		const childCount = dataset.folders.filter((folder) =>
			normalizeFolderSelector(folderPath(folder)).startsWith(
				`${normalizeFolderSelector(root)}/`,
			),
		).length;
		const messageRefs = (dataset.messages as OutlookMessage[]).filter(
			(message) =>
				normalizeFolderSelector(message.folderName ?? message.folderId) ===
				normalizeFolderSelector(root),
		).length;
		findings.push({
			status:
				rootFolder && (childCount > 0 || messageRefs > 0) ? "warn" : "pass",
			check: "legacy-root-removable",
			detail: `${root}: children=${childCount}, messageRefs=${messageRefs}`,
		});
	}

	const systemFolders =
		cleanupPlan.verification?.systemFolderNames ??
		cleanupPlan.folders.systemFolderNames ??
		[];
	const folderReport = await readJsonFileIfExists<{
		folders?: FolderAction[];
		mutationTarget?: string;
	}>(join(paths.reportsDir, providerFileName(context, "folder-tree")));
	const touchedSystemFolders = (folderReport?.folders ?? []).filter(
		(action) => {
			const path =
				"displayPath" in action ? action.displayPath : action.toDisplayPath;
			return systemFolders.some((name) => normalize(path) === normalize(name));
		},
	);
	findings.push({
		status: touchedSystemFolders.length > 0 ? "fail" : "pass",
		check: "system-folders-untouched",
		detail: `${touchedSystemFolders.length} system folder action(s)`,
	});

	const reportNames = ["folder-tree", "label", "filter", "inbox-route"];
	for (const name of reportNames) {
		const report = await readJsonFileIfExists<{
			mutated?: boolean;
			mutationTarget?: string;
		}>(join(paths.reportsDir, providerFileName(context, name)));
		findings.push({
			status:
				report?.mutationTarget === cleanupPlan.artifacts.mutationTarget
					? "pass"
					: "warn",
			check: "mutation-target-reported",
			detail: `${name}: ${report?.mutationTarget ?? "missing"}`,
		});
	}

	return findings;
}

function messageHasLabel(message: OutlookMessage, name: string): boolean {
	return [...(message.labels ?? []), ...(message.categories ?? [])].some(
		(label) => normalize(label) === normalize(name),
	);
}

function buildLabelBeforeAfter(
	dataset: OutlookDataset,
	actions: LabelAction[],
): unknown {
	const before = currentLabels(dataset)
		.map((label) => label.name)
		.sort((left, right) => left.localeCompare(right));
	const after = new Set(before);
	const created: string[] = [];
	const removed: string[] = [];
	const renamed: { from: string; to: string }[] = [];
	const refused: { name: string; reason: string }[] = [];
	for (const action of actions) {
		if (action.action === "create") {
			after.add(action.name);
			created.push(action.name);
			continue;
		}
		if (action.action === "delete") {
			after.delete(action.name);
			removed.push(action.name);
			continue;
		}
		if (action.action === "rename") {
			after.delete(action.from);
			after.add(action.to);
			renamed.push({ from: action.from, to: action.to });
			continue;
		}
		if (action.action === "refuse-delete") {
			refused.push({ name: action.name, reason: action.reason });
		}
	}
	return {
		before,
		after: [...after].sort((left, right) => left.localeCompare(right)),
		created: created.sort((left, right) => left.localeCompare(right)),
		removed: removed.sort((left, right) => left.localeCompare(right)),
		renamed: renamed.sort((left, right) => left.from.localeCompare(right.from)),
		refused: refused.sort((left, right) => left.name.localeCompare(right.name)),
	};
}

async function buildCleanupVisualizationPayload(
	context: CliContext,
	paths: ReturnType<typeof workspacePaths>,
	cleanupPlan: OutlookCleanupPlan,
): Promise<{
	template: "plan";
	slug: string;
	title: string;
	date: string;
	summary: {
		provider: MailProvider;
		dir: string;
		mutationTarget: string;
		scanned: unknown;
		routed: unknown;
		skipped: unknown;
		verificationFailed: unknown;
	};
	sections: Record<string, unknown>;
	patchContract: CleanupPatch;
}> {
	const routeReport =
		(await readJsonFileIfExists<Record<string, unknown>>(
			join(paths.reportsDir, providerFileName(context, "inbox-route-dry-run")),
		)) ??
		(await readJsonFileIfExists<Record<string, unknown>>(
			join(paths.reportsDir, providerFileName(context, "inbox-route")),
		));
	const verification = await readJsonFileIfExists<Record<string, unknown>>(
		join(paths.reportsDir, providerFileName(context, "cleanup-verify")),
	);
	const dataset = await readOutlookDataset(context);
	const labelPlan = buildLabelPlan(
		context.config.provider,
		paths.dir,
		dataset,
		true,
		cleanupPlan,
	);
	return {
		template: "plan",
		slug: `${context.config.provider}-cleanup-plan`,
		title: "Mailbox Cleanup Plan",
		date: new Date().toISOString().slice(0, 10),
		summary: {
			provider: context.config.provider,
			dir: paths.dir,
			mutationTarget: cleanupPlan.artifacts.mutationTarget,
			scanned: routeReport?.scanned,
			routed: routeReport?.route,
			skipped: routeReport?.skip,
			verificationFailed: verification?.failed ?? 0,
		},
		sections: {
			folders: cleanupPlan.folders,
			labels: cleanupPlan.labels,
			filters: {
				refusedDomains: cleanupPlan.filters.refusedDomains,
				refusedDomainReason: cleanupPlan.filters.refusedDomainReason,
				rules: cleanupPlan.filters.rules.map((rule) => ({
					name: rule.name,
					targetSegments: rule.targetSegments,
					labelNames: rule.labelNames ?? [],
					priority: rule.priority,
					reason: rule.reason,
				})),
			},
			routing: cleanupPlan.routing,
			routeDestinationCounts: routeReport?.destinationCounts ?? {},
			labelBeforeAfter: buildLabelBeforeAfter(dataset, labelPlan.actions),
			verificationFindings: verification?.findings ?? [],
		},
		patchContract: {
			kind: "mailbox-cleanup-plan-patch",
			operations: [
				{
					op: "set",
					path: ["filters", "rules", "0", "targetSegments"],
					value: ["Folder"],
				},
				{ op: "append", path: ["labels", "create"], value: "Label" },
				{
					op: "remove",
					path: ["filters", "refusedDomains"],
					value: "example.test",
				},
			],
		},
	};
}

async function remakeCleanupDryRunPlans(
	context: CliContext,
	paths: ReturnType<typeof workspacePaths>,
	cleanupPlan: OutlookCleanupPlan,
): Promise<RemadeCleanupPlans> {
	const folders = await loadFolderSnapshot(context, paths);
	const dataset = await readOutlookDataset(context);
	const routeLimit = getNumberFlag(
		context.args.flags,
		"limit",
		providerBatchSize(context.config, context.config.provider),
	);
	const folderPlan = buildFolderTreePlan(
		context.config.provider,
		paths.dir,
		folders,
		true,
		cleanupPlan,
	);
	const labelPlan = buildLabelPlan(
		context.config.provider,
		paths.dir,
		dataset,
		true,
		cleanupPlan,
	);
	const filterPlan = buildFilterPlan(
		context.config.provider,
		paths.dir,
		dataset,
		true,
		cleanupPlan,
	);
	const routePlan = buildRoutePlan(
		context.config.provider,
		paths.dir,
		dataset,
		true,
		routeLimit,
		cleanupPlan,
	);
	const pathsWritten = {
		remadeAt: new Date().toISOString(),
		folderPlanPath: join(
			paths.plansDir,
			providerFileName(context, "folder-tree-plan"),
		),
		folderDryRunPath: join(
			paths.reportsDir,
			providerFileName(context, "folder-tree-dry-run"),
		),
		labelPlanPath: join(
			paths.plansDir,
			providerFileName(context, "label-plan"),
		),
		labelDryRunPath: join(
			paths.reportsDir,
			providerFileName(context, "label-dry-run"),
		),
		filterPlanPath: join(
			paths.plansDir,
			providerFileName(context, "filter-plan"),
		),
		filterDryRunPath: join(
			paths.reportsDir,
			providerFileName(context, "filter-dry-run"),
		),
		routePlanPath: join(
			paths.plansDir,
			providerFileName(context, "inbox-route-plan"),
		),
		routeDryRunPath: join(
			paths.reportsDir,
			providerFileName(context, "inbox-route-dry-run"),
		),
	};
	await writeJsonFile(pathsWritten.folderPlanPath, folderPlan);
	await writeJsonFile(
		pathsWritten.folderDryRunPath,
		summarizeFolderTreePlan(folderPlan),
	);
	await writeJsonFile(pathsWritten.labelPlanPath, labelPlan);
	await writeJsonFile(
		pathsWritten.labelDryRunPath,
		summarizeLabelPlan(labelPlan),
	);
	await writeJsonFile(pathsWritten.filterPlanPath, filterPlan);
	await writeJsonFile(
		pathsWritten.filterDryRunPath,
		summarizeFilterPlan(filterPlan),
	);
	await writeJsonFile(
		pathsWritten.routePlanPath,
		compactRoutePlanForStorage(routePlan, cleanupPlan),
	);
	await writeJsonFile(
		pathsWritten.routeDryRunPath,
		summarizeRoutePlan(routePlan),
	);
	return pathsWritten;
}

async function startCleanupReviewServer(input: {
	html: string;
	reviewPath: string;
	expectation: CleanupReviewExpectation;
	timeoutSeconds: number;
}): Promise<{
	reviewUrl: string;
	timeoutSeconds: number;
	review: Promise<CleanupReviewPayload>;
	server: { port: number; stop: () => void };
	stop: () => void;
}> {
	let resolveReview: (review: CleanupReviewPayload) => void = () => undefined;
	let rejectReview: (error: Error) => void = () => undefined;
	const review = new Promise<CleanupReviewPayload>(
		(resolvePromise, rejectPromise) => {
			resolveReview = resolvePromise;
			rejectReview = rejectPromise;
		},
	);
	const timeoutSeconds = Math.max(1, input.timeoutSeconds);
	const timeout = setTimeout(() => {
		rejectReview(
			new Error(`Cleanup review timed out after ${timeoutSeconds} second(s)`),
		);
	}, timeoutSeconds * 1000);
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			return handleCleanupReviewRequest(request, input, resolveReview);
		},
	});
	const port = server.port;
	if (port === undefined) {
		throw new Error("Cleanup review server started without a port.");
	}
	return {
		reviewUrl: `http://127.0.0.1:${port}/review`,
		timeoutSeconds,
		review,
		server: {
			port,
			stop: () => server.stop(),
		},
		stop: () => {
			clearTimeout(timeout);
			server.stop();
		},
	};
}

async function handleCleanupReviewRequest(
	request: Request,
	input: {
		html: string;
		reviewPath: string;
		expectation: CleanupReviewExpectation;
	},
	resolveReview: (review: CleanupReviewPayload) => void,
): Promise<Response> {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (
		request.method === "GET" &&
		(url.pathname === "/" || url.pathname === "/review")
	) {
		return new Response(input.html, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
	if (request.method === "POST" && url.pathname === "/review") {
		try {
			const submitted = await readRequestJson(request);
			const normalized = validateCleanupReviewPayload(
				submitted,
				input.expectation,
			);
			await writeJsonFile(input.reviewPath, normalized);
			resolveReview(normalized);
			return Response.json({
				ok: true,
				review: normalized,
				closeAfterSubmit: true,
			});
		} catch (error) {
			return Response.json(
				{
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				},
				{ status: 400 },
			);
		}
	}
	return new Response("Not found", {
		status: 404,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

async function readRequestJson(request: Request): Promise<unknown> {
	return request.json();
}

export function validateCleanupReviewPayload(
	input: unknown,
	expectation: CleanupReviewExpectation,
): CleanupReviewPayload {
	if (!isRecord(input)) {
		throw new Error("Cleanup review payload must be an object");
	}
	if (input.kind !== "mailbox-cleanup-plan-review") {
		throw new Error(
			"Cleanup review payload kind must be mailbox-cleanup-plan-review",
		);
	}
	if (input.provider !== expectation.provider) {
		throw new Error(
			`Cleanup review provider mismatch: expected ${expectation.provider}`,
		);
	}
	if (input.dir !== expectation.dir) {
		throw new Error(`Cleanup review dir mismatch: expected ${expectation.dir}`);
	}
	if (input.mutationTarget !== expectation.mutationTarget) {
		throw new Error(
			`Cleanup review mutation target mismatch: expected ${expectation.mutationTarget}`,
		);
	}
	if (!["approve", "reject"].includes(String(input.verdict))) {
		throw new Error("Cleanup review verdict must be approve or reject");
	}
	const verdict = input.verdict as CleanupReviewVerdict;
	const comment = typeof input.comment === "string" ? input.comment.trim() : "";
	if (verdict === "reject" && comment === "") {
		throw new Error("Cleanup review comment is required for rejection");
	}
	if (
		verdict === "approve" &&
		expectation.hasVerificationFailures &&
		comment === ""
	) {
		throw new Error(
			"Cleanup review comment is required to approve with verification failures",
		);
	}
	if (!Array.isArray(input.sectionComments)) {
		throw new Error("Cleanup review sectionComments must be an array");
	}
	const sectionComments = input.sectionComments
		.map((row) => {
			if (
				!isRecord(row) ||
				typeof row.section !== "string" ||
				typeof row.comment !== "string"
			) {
				throw new Error(
					"Cleanup review section comments require section and comment strings",
				);
			}
			return { section: row.section.trim(), comment: row.comment.trim() };
		})
		.filter((row) => row.section !== "" && row.comment !== "");
	if (!isRecord(input.patch)) {
		throw new Error("Cleanup review patch must be an object");
	}
	const patch = input.patch as CleanupPatch;
	validateCleanupPatch(patch, "cleanup review payload");
	return {
		kind: "mailbox-cleanup-plan-review",
		provider: expectation.provider,
		dir: expectation.dir,
		mutationTarget: expectation.mutationTarget,
		verdict,
		comment,
		sectionComments,
		patch: { kind: "mailbox-cleanup-plan-patch", operations: patch.operations },
		submittedAt: new Date().toISOString(),
	};
}

async function openBrowser(url: string): Promise<boolean> {
	const command = browserOpenCommand(url);
	try {
		Bun.spawn(command, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		}).unref();
		return true;
	} catch {
		return false;
	}
}

function browserOpenCommand(url: string): string[] {
	if (process.platform === "darwin") {
		return ["open", url];
	}
	if (process.platform === "win32") {
		return ["cmd", "/c", "start", "", url];
	}
	return ["xdg-open", url];
}

function renderCleanupVisualizationHtml(payload: unknown): string {
	const serializedPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mailbox Cleanup Plan</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #05070c;
      color: #e8f6ff;
      --panel: #0b1018;
      --panel-2: #101725;
      --line: rgba(51, 236, 255, 0.34);
      --cyan: #33ecff;
      --pink: #ff4fb8;
      --yellow: #ffd166;
      --violet: #9b7cff;
      --text-dim: #91a6b8;
      --safe: #36f3a2;
    }
    * { box-sizing: border-box; }
    body.neon-control-surface { margin: 0; min-height: 100vh; background: radial-gradient(circle at 20% 0%, rgba(51, 236, 255, 0.12), transparent 26rem), #05070c; }
    header { position: sticky; top: 0; z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 22px; background: rgba(5, 7, 12, 0.92); border-bottom: 1px solid var(--line); backdrop-filter: blur(18px); }
    h1 { margin: 0; font-size: 22px; font-weight: 760; letter-spacing: 0; }
    h2, h3 { margin: 0; letter-spacing: 0; }
    h2 { font-size: 15px; }
    h3 { font-size: 13px; color: #dff8ff; }
    main { width: min(1440px, 100%); margin: 0 auto; padding: 22px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 390px); gap: 18px; align-items: start; }
    .evidence { display: grid; gap: 12px; }
    .review-panel, details { background: linear-gradient(180deg, rgba(16, 23, 37, 0.96), rgba(9, 14, 23, 0.96)); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 0 0 1px rgba(155, 124, 255, 0.08), 0 0 24px rgba(51, 236, 255, 0.06); }
    .review-panel { position: sticky; top: 82px; display: grid; gap: 14px; padding: 16px; }
    summary { list-style: none; cursor: pointer; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid rgba(51, 236, 255, 0.14); }
    summary::-webkit-details-marker { display: none; }
    details:not([open]) summary { border-bottom: 0; }
    .section-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .section-title span { color: var(--text-dim); font-size: 12px; }
    .section-body { padding: 14px 16px 16px; display: grid; gap: 14px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 10px; }
    .metric { min-height: 74px; padding: 10px; border: 1px solid rgba(155, 124, 255, 0.34); border-radius: 8px; background: rgba(5, 8, 14, 0.72); }
    .metric span { display: block; color: var(--text-dim); font-size: 12px; line-height: 1.35; }
    .metric strong { display: block; margin-top: 6px; color: #ffffff; font-size: 18px; line-height: 1.2; overflow-wrap: anywhere; }
    .metric.warning strong { color: var(--yellow); }
    .metric.safe strong { color: var(--safe); }
    .summary-line { margin: 0; color: var(--text-dim); font-size: 13px; line-height: 1.45; }
    .explain { border: 1px solid rgba(255, 209, 102, 0.28); border-radius: 8px; background: rgba(255, 209, 102, 0.07); padding: 10px 12px; color: #ffe5a3; font-size: 13px; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid rgba(145, 166, 184, 0.18); padding: 9px 8px; text-align: left; vertical-align: top; }
    th { color: var(--cyan); font-weight: 650; background: rgba(51, 236, 255, 0.06); }
    textarea, input { width: 100%; border: 1px solid rgba(51, 236, 255, 0.28); border-radius: 8px; padding: 10px; color: #eefaff; background: #060a11; outline: none; }
    textarea:focus, input:focus { border-color: var(--violet); box-shadow: 0 0 0 3px rgba(155, 124, 255, 0.16); }
    textarea { min-height: 118px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; }
    label { display: grid; gap: 7px; color: #dff8ff; font-size: 13px; font-weight: 650; }
    button { border: 1px solid rgba(51, 236, 255, 0.36); background: rgba(51, 236, 255, 0.08); color: #e8f6ff; border-radius: 8px; padding: 9px 11px; cursor: pointer; font: inherit; }
    button:hover { border-color: var(--cyan); box-shadow: 0 0 14px rgba(51, 236, 255, 0.16); }
    button:disabled { cursor: not-allowed; opacity: 0.55; box-shadow: none; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .muted { color: var(--text-dim); font-size: 13px; line-height: 1.45; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .pill { display: inline-block; border: 1px solid rgba(51, 236, 255, 0.28); border-radius: 999px; padding: 3px 8px; margin: 2px; color: #dff8ff; background: rgba(51, 236, 255, 0.07); font-size: 12px; }
    .pill.added { border-color: rgba(54, 243, 162, 0.58); color: #dfffee; background: rgba(54, 243, 162, 0.13); }
    .pill.removed { border-color: rgba(255, 79, 184, 0.62); color: #ffd6ee; background: rgba(255, 79, 184, 0.12); }
    .pill.renamed { border-color: rgba(255, 209, 102, 0.68); color: #fff1c4; background: rgba(255, 209, 102, 0.13); }
    .pill.renamed s { color: rgba(255, 241, 196, 0.72); }
    .label-cloud { border: 1px solid rgba(145, 166, 184, 0.18); border-radius: 8px; padding: 10px; background: rgba(5, 8, 14, 0.48); }
    .variant-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
    .variant-tabs button { padding: 7px 10px; font-size: 12px; }
    .variant-tabs button[aria-pressed="true"] { border-color: var(--violet); background: rgba(155, 124, 255, 0.24); color: #ffffff; }
    .variant-view[hidden] { display: none; }
    .compact-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .compact-list li { border: 1px solid rgba(145, 166, 184, 0.18); border-radius: 8px; padding: 8px 10px; background: rgba(5, 8, 14, 0.48); }
    .folder-map { display: grid; gap: 12px; }
    .folder-map-row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 12px; align-items: stretch; padding: 12px; border: 1px solid rgba(145, 166, 184, 0.2); border-radius: 8px; background: rgba(5, 8, 14, 0.5); }
    .folder-map-panel { padding: 12px; border: 1px solid rgba(51, 236, 255, 0.18); border-radius: 8px; background: rgba(3, 6, 10, 0.56); }
    .folder-map-panel strong { display: block; margin-bottom: 8px; color: var(--cyan); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .folder-map-arrow { align-self: center; color: var(--yellow); font-weight: 760; }
    .folder-tree { margin: 0; padding: 10px 12px; border: 1px solid rgba(145, 166, 184, 0.16); border-radius: 8px; background: #03060a; color: #dff8ff; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; white-space: pre; overflow: auto; }
    .status-pass { color: var(--safe); }
    .status-warn { color: var(--yellow); }
    .status-fail { color: var(--pink); }
    .segmented { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 4px; border: 1px solid rgba(155, 124, 255, 0.32); border-radius: 8px; background: rgba(5, 8, 14, 0.8); }
    .segmented button { min-height: 44px; border-color: transparent; background: transparent; color: var(--text-dim); padding: 8px; }
    .segmented button[aria-pressed="true"] { color: #061015; font-weight: 760; }
    .segmented button[data-verdict="approve"][aria-pressed="true"] { background: var(--safe); }
    .segmented button[data-verdict="reject"][aria-pressed="true"] { background: var(--pink); }
    .submit { width: 100%; min-height: 46px; border-color: var(--violet); background: rgba(155, 124, 255, 0.2); color: #ffffff; font-weight: 760; }
    .note-row[hidden], .hidden { display: none; }
    .note-action { white-space: nowrap; color: var(--cyan); background: rgba(51, 236, 255, 0.06); padding: 6px 9px; font-size: 12px; }
    .confirmation { border: 1px solid rgba(54, 243, 162, 0.42); background: rgba(54, 243, 162, 0.08); border-radius: 8px; padding: 10px; color: #dfffee; }
    .error { border: 1px solid rgba(255, 79, 184, 0.48); background: rgba(255, 79, 184, 0.09); border-radius: 8px; padding: 10px; color: #ffd6ee; }
    pre { overflow: auto; max-height: 420px; margin: 0; background: #03060a; border: 1px solid rgba(145, 166, 184, 0.18); border-radius: 8px; padding: 12px; color: #dff8ff; font-size: 12px; line-height: 1.45; }
    code { color: var(--yellow); }
    @media (max-width: 860px) {
      header { position: static; align-items: flex-start; flex-direction: column; }
      main { padding: 14px; }
      .workspace { grid-template-columns: 1fr; }
      .review-panel { position: static; }
      .segmented { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body class="neon-control-surface">
  <header>
    <div>
      <h1>Mailbox Cleanup Plan</h1>
      <div class="muted">Operator review console</div>
    </div>
    <div class="toolbar">
      <button type="button" id="downloadReview">Download Review JSON</button>
    </div>
  </header>
  <main>
    <div class="workspace">
      <div class="evidence" id="evidence"></div>
      <aside class="review-panel" aria-label="Review decision panel">
        <div>
          <h2>Review Decision</h2>
          <div class="muted" id="decisionState">Current decision state: approve</div>
        </div>
        <div class="segmented" role="group" aria-label="Verdict">
          <button type="button" data-verdict="approve" aria-pressed="true">Approve</button>
          <button type="button" data-verdict="reject" aria-pressed="false">Reject</button>
        </div>
        <label>Overall comment
          <textarea id="overallComment" placeholder="Required for rejection and approval with verification failures."></textarea>
        </label>
        <button type="button" class="submit" id="submitReview">Submit approval</button>
        <div id="submitStatus" class="muted"></div>
        <label>Review JSON
          <textarea id="reviewJson" readonly></textarea>
        </label>
      </aside>
    </div>
  </main>
  <script>
    const payload = ${serializedPayload};
    let verdict = "approve";
    let locked = false;
    const el = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const pillList = (values) => (values ?? []).map((value) => '<span class="pill">' + escapeHtml(value) + '</span>').join("");
    const typedPill = (value, tone, title) => '<span class="pill ' + escapeHtml(tone) + '"' + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(value) + '</span>';
    const metric = (label, value, tone) => '<div class="metric ' + (tone || "") + '"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value ?? "-") + '</strong></div>';
    const sections = payload.sections ?? {};
    const summary = payload.summary ?? {};
    const verificationFindings = sections.verificationFindings ?? [];
    const verificationFailures = Number(summary.verificationFailed ?? 0);
    const patchTemplate = { kind: "mailbox-cleanup-plan-patch", operations: [] };

    function detail(id, title, subtitle, body, open) {
      return '<details id="section-' + escapeHtml(id) + '"' + (open ? ' open' : '') + '>' +
        '<summary><div class="section-title"><h2>' + escapeHtml(title) + '</h2><span>' + escapeHtml(subtitle || "") + '</span></div><button type="button" class="note-action" data-note-toggle="' + escapeHtml(id) + '">Add note</button></summary>' +
        '<div class="section-body"><label class="note-row" data-note-row="' + escapeHtml(id) + '" hidden>Section note<textarea data-section-comment="' + escapeHtml(id) + '" placeholder="Add a note for ' + escapeHtml(title) + '"></textarea></label>' + body + '</div>' +
        '</details>';
    }

    function renderSummary() {
      const tone = verificationFailures > 0 ? "warning" : "safe";
      return '<div class="explain">This is the top-level decision snapshot. Use it to decide whether the plan is ready for approval before drilling into route destinations, policy checks, and rule details.</div>' +
        '<p class="summary-line">' + escapeHtml(summary.provider) + ' · ' + escapeHtml(summary.dir) + ' · ' + escapeHtml(summary.mutationTarget) + '</p>' +
        '<div class="metrics">' + [
          metric("Routes", summary.routed ?? 0, "safe"),
          metric("Skipped", summary.skipped ?? 0),
          metric("Verification failures", verificationFailures, tone),
          metric("Filters", (sections.filters?.rules ?? []).length)
        ].join("") + '</div>';
    }

    function renderVerification() {
      if (verificationFindings.length === 0) {
        return '<p class="muted">No verification report was found. Run <code>cleanup verify</code> before approving a live cleanup.</p>';
      }
      return '<div class="explain">Verification is the final consistency check between the cleanup policy, current mailbox snapshot, and generated reports. Failed checks mean the plan should be rejected or explained before approval; warnings usually mean supporting dry-run/apply reports should be regenerated.</div>' +
        '<table><thead><tr><th>Status</th><th>Check</th><th>What it means</th></tr></thead><tbody>' +
        verificationFindings.map((finding) => '<tr><td class="status-' + escapeHtml(finding.status) + '">' + escapeHtml(finding.status) + '</td><td>' + escapeHtml(finding.check) + '</td><td>' + escapeHtml(finding.detail) + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function renderRoutes() {
      const counts = sections.routeDestinationCounts ?? {};
      return '<div class="explain">Routes show where Inbox messages would land under the current plan. High skipped counts mean more messages need review before the cleanup can be considered complete.</div>' +
        '<table><thead><tr><th>Destination</th><th>Total</th><th>Unread</th><th>Read</th></tr></thead><tbody>' +
        Object.entries(counts).map(([destination, row]) => '<tr><td>' + escapeHtml(destination) + '</td><td>' + escapeHtml(row.total) + '</td><td>' + escapeHtml(row.unread) + '</td><td>' + escapeHtml(row.read) + '</td></tr>').join("") +
        '</tbody></table><p class="muted">Unmatched reason: ' + escapeHtml((sections.routing ?? {}).unmatchedReason) + '</p>';
    }

    function renderFolders() {
      const folders = sections.folders ?? {};
      const children = folders.children ?? [];
      const moves = folders.legacyMoves ?? [];
      const pathTree = (segments, extraChildren) => {
        const safeSegments = (segments ?? []).filter(Boolean);
        if (safeSegments.length === 0) {
          return '<pre class="folder-tree">Mailbox root</pre>';
        }
        const lines = [];
        safeSegments.forEach((segment, index) => {
          const prefix = index === 0 ? "" : "    ".repeat(index - 1) + "+-- ";
          lines.push(prefix + segment);
        });
        (extraChildren ?? []).forEach((child, index, allChildren) => {
          const connector = index === allChildren.length - 1 ? "+-- " : "|-- ";
          lines.push("    ".repeat(Math.max(safeSegments.length - 1, 0)) + connector + child);
        });
        return '<pre class="folder-tree">' + escapeHtml(lines.join("\\n")) + '</pre>';
      };
      const splitOldPath = (path) => String(path ?? "").split(/[/>]/).map((segment) => segment.trim()).filter(Boolean);
      const folderMapRows = moves.map((move) => {
        const targetKey = (move.toSegments ?? []).join(" > ");
        const childGroup = children.find((group) => (group.parentSegments ?? []).join(" > ") === targetKey);
        return '<div class="folder-map-row">' +
          '<div class="folder-map-panel"><strong>Old</strong>' + pathTree(splitOldPath(move.fromPath), []) + '</div>' +
          '<div class="folder-map-arrow">to</div>' +
          '<div class="folder-map-panel"><strong>New</strong>' + pathTree(move.toSegments, childGroup?.names ?? []) + '</div>' +
        '</div>';
      }).join("");
      return '<div class="explain">Folders define the mailbox destination structure. Review top-level destinations first, then child folders, then legacy moves from old roots into the new structure.</div>' +
        '<div class="metrics">' + [
          metric("Top level", (folders.topLevel ?? []).length),
          metric("Child groups", children.length),
          metric("Child folders", children.reduce((total, group) => total + (group.names ?? []).length, 0)),
          metric("Legacy moves", moves.length)
        ].join("") + '</div>' +
        '<h3>Old to new folder tree</h3>' +
        '<div class="folder-map">' + (folderMapRows || '<p class="muted">No legacy folder moves are planned.</p>') + '</div>';
    }

    function renderLabels() {
      const beforeAfter = sections.labelBeforeAfter ?? {};
      const renderBeforeAfterLabels = () => {
        const createdSet = new Set(beforeAfter.created ?? []);
        const removedSet = new Set(beforeAfter.removed ?? []);
        const renameRows = beforeAfter.renamed ?? [];
        const renamedFromSet = new Set(renameRows.map((row) => row.from));
        const renamedToSet = new Set(renameRows.map((row) => row.to));
        const refusedReasonByName = new Map((beforeAfter.refused ?? []).map((row) => [row.name, row.reason]));
        const unchangedLabels = [...new Set([...(beforeAfter.before ?? []), ...(beforeAfter.after ?? [])])]
          .filter((name) => !renamedFromSet.has(name) && !renamedToSet.has(name))
          .map((name) => {
            const tone = createdSet.has(name) ? "added" : removedSet.has(name) ? "removed" : "";
            const title = refusedReasonByName.has(name) ? "Refused delete: " + refusedReasonByName.get(name) : "";
            return {
              sortKey: String(name).toLocaleLowerCase(),
              html: typedPill(name, tone, title),
            };
          });
        const renamedLabels = renameRows.map((row) => ({
          sortKey: String(row.to).toLocaleLowerCase(),
          html: '<span class="pill renamed"><s>' + escapeHtml(row.from) + '</s> <strong>' + escapeHtml(row.to) + '</strong></span>',
        }));
        const pills = [...unchangedLabels, ...renamedLabels]
          .sort((left, right) => left.sortKey.localeCompare(right.sortKey))
          .map((item) => item.html)
          .join("");
        return '<div class="label-cloud">' + (pills || '<span class="muted">No labels found.</span>') + '</div>' +
          '<p class="muted">Neutral labels are kept, green labels are added, red labels are deleted, and yellow labels are renamed.</p>';
      };
      return '<div class="explain">Labels are secondary to Filters in this plan. Review destructive delete candidates here, and use the filter-linked view to see which labels are actually applied by rules.</div>' +
        '<h3>All labels</h3>' + renderBeforeAfterLabels();
    }

    function renderFilters() {
      const filters = sections.filters ?? {};
      return '<div class="explain">Filters are the source of truth for recurring routing. Each row links a rule to its destination folder and any labels it applies.</div>' +
        '<table><thead><tr><th>Name</th><th>Destination</th><th>Applied labels</th><th>Reason</th><th>Priority</th></tr></thead><tbody>' +
        (filters.rules ?? []).map((rule) => '<tr><td>' + escapeHtml(rule.name) + '</td><td>' + escapeHtml((rule.targetSegments ?? []).join(" > ")) + '</td><td>' + pillList(rule.labelNames) + '</td><td>' + escapeHtml(rule.reason) + '</td><td>' + escapeHtml(rule.priority) + '</td></tr>').join("") +
        '</tbody></table><p class="muted">Refused domains: ' + pillList(filters.refusedDomains) + '</p>';
    }

    function renderAdvanced() {
      return '<div class="explain">Advanced JSON is for agent handoff and precise patching. Most human review should happen in the sections above; use this only when you need to submit exact patch operations.</div>' +
        '<label>Patch editor<textarea id="patch"></textarea></label>' +
        '<p class="muted">Patch operations can be saved and passed to <code>cleanup plan-patch --patch-path &lt;file&gt;</code>.</p>' +
        '<h3>Raw payload</h3><pre id="raw"></pre>';
    }

    function renderEvidence() {
      el("evidence").innerHTML = [
        detail("summary", "Summary", "target, routes, filters, verification", renderSummary(), true),
        detail("verification", "Verification", "policy and report consistency checks", renderVerification(), false),
        detail("routes", "Routes", "destination counts and skipped messages", renderRoutes(), true),
        detail("folders", "Folders", "planned folder tree and legacy moves", renderFolders(), false),
        detail("labels", "Labels", "kept, created, and deleted categories", renderLabels(), false),
        detail("filters", "Filters", "rule destinations, labels, and refused domains", renderFilters(), false),
        detail("advanced", "Advanced JSON", "patch editor and raw payload", renderAdvanced(), false)
      ].join("");
      el("patch").value = JSON.stringify(patchTemplate, null, 2);
      el("raw").textContent = JSON.stringify(payload, null, 2);
      document.querySelectorAll("[data-note-toggle]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          const section = button.dataset.noteToggle;
          const row = document.querySelector('[data-note-row="' + section + '"]');
          if (!row) {
            return;
          }
          row.hidden = !row.hidden;
          if (!row.hidden) {
            row.querySelector("textarea").focus();
          }
        });
      });
      document.querySelectorAll("[data-section-comment]").forEach((input) => input.addEventListener("input", updateReview));
      el("patch").addEventListener("input", updateReview);
    }

    function submitText() {
      if (verdict === "reject") {
        return "Submit rejection";
      }
      return "Submit approval";
    }

    function reviewPayload() {
      const patchValue = JSON.parse(el("patch").value || '{"kind":"mailbox-cleanup-plan-patch","operations":[]}');
      return {
      kind: "mailbox-cleanup-plan-review",
      provider: summary.provider,
      dir: summary.dir,
      mutationTarget: summary.mutationTarget,
      verdict,
      comment: el("overallComment").value.trim(),
      sectionComments: Array.from(document.querySelectorAll("[data-section-comment]"))
        .map((input) => ({ section: input.dataset.sectionComment, comment: input.value.trim() }))
        .filter((row) => row.comment),
      patch: patchValue,
      submittedAt: new Date().toISOString()
      };
    }

    function validateForSubmit(payloadValue) {
      if (payloadValue.verdict === "reject" && !payloadValue.comment) {
        return "Comment required for rejection.";
      }
      if (payloadValue.verdict === "approve" && verificationFailures > 0 && !payloadValue.comment) {
        return "Comment required to approve with verification failures.";
      }
      return "";
    }

    function updateReview() {
      document.querySelectorAll("[data-verdict]").forEach((button) => button.setAttribute("aria-pressed", button.dataset.verdict === verdict ? "true" : "false"));
      el("submitReview").textContent = submitText();
      el("decisionState").textContent = "Current decision state: " + verdict.replace("_", " ");
      try {
        const value = reviewPayload();
        el("reviewJson").value = JSON.stringify(value, null, 2);
        const validationError = validateForSubmit(value);
        el("submitStatus").textContent = validationError;
        el("submitStatus").className = validationError ? "error" : "muted";
      } catch (error) {
        el("reviewJson").value = JSON.stringify({ kind: "mailbox-cleanup-plan-review", verdict, error: String(error) }, null, 2);
        el("submitStatus").textContent = "Patch JSON is not valid.";
        el("submitStatus").className = "error";
      }
    }

    async function submitReview() {
      if (locked) {
        return;
      }
      let value;
      try {
        value = reviewPayload();
      } catch {
        updateReview();
        return;
      }
      const validationError = validateForSubmit(value);
      if (validationError) {
        updateReview();
        return;
      }
      if (location.protocol !== "http:" && location.protocol !== "https:") {
        el("submitStatus").textContent = "No local receiver is active. Use Download Review JSON.";
        el("submitStatus").className = "error";
        return;
      }
      el("submitReview").disabled = true;
      el("submitStatus").textContent = "Submitting review...";
      el("submitStatus").className = "muted";
      const response = await fetch("/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value)
      });
      const body = await response.json();
      if (!response.ok) {
        el("submitReview").disabled = false;
        el("submitStatus").textContent = body.error || "Review submission failed.";
        el("submitStatus").className = "error";
        return;
      }
      locked = true;
      document.querySelectorAll("textarea, input, button[data-verdict], .note-action").forEach((control) => control.disabled = true);
      el("reviewJson").value = JSON.stringify(body.review, null, 2);
      el("submitStatus").className = "confirmation";
      el("submitStatus").textContent = "Submitted " + body.review.verdict + " at " + body.review.submittedAt + ". Closing this tab...";
      if (body.closeAfterSubmit) {
        setTimeout(() => {
          window.close();
          el("submitStatus").textContent = "Submitted " + body.review.verdict + " at " + body.review.submittedAt + ". This tab can be closed.";
        }, 250);
      }
    }

    function downloadReview() {
      updateReview();
      const blob = new Blob([el("reviewJson").value + "\\n"], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "mailbox-cleanup-review.json";
      link.click();
      URL.revokeObjectURL(link.href);
    }

    renderEvidence();
    document.querySelectorAll("[data-verdict]").forEach((button) => button.addEventListener("click", () => {
      if (locked) {
        return;
      }
      verdict = button.dataset.verdict;
      updateReview();
    }));
    el("overallComment").addEventListener("input", updateReview);
    el("submitReview").addEventListener("click", submitReview);
    updateReview();
    el("downloadReview").addEventListener("click", downloadReview);
  </script>
</body>
</html>
`;
}

function validateCleanupPatch(patch: CleanupPatch, patchPath: string): void {
	if (!Array.isArray(patch.operations)) {
		throw new Error(`Invalid cleanup patch operations: ${patchPath}`);
	}
	for (const operation of patch.operations) {
		if (
			!["set", "append", "remove"].includes(operation.op) ||
			!Array.isArray(operation.path) ||
			operation.path.length === 0
		) {
			throw new Error(`Invalid cleanup patch operation: ${patchPath}`);
		}
		if (
			![
				"folders",
				"labels",
				"filters",
				"routing",
				"verification",
				"artifacts",
			].includes(operation.path[0] ?? "")
		) {
			throw new Error(
				`Cleanup patch cannot edit unsupported root: ${operation.path[0]}`,
			);
		}
	}
}

function applyPatchOperations(
	plan: OutlookCleanupPlan,
	operations: CleanupPatchOperation[],
): OutlookCleanupPlan {
	const next = structuredClone(plan) as OutlookCleanupPlan;
	for (const operation of operations) {
		applyPatchOperation(next as unknown as Record<string, unknown>, operation);
	}
	return next;
}

function applyPatchOperation(
	target: Record<string, unknown>,
	operation: CleanupPatchOperation,
): void {
	const parent = parentForPath(target, operation.path);
	const key = operation.path[operation.path.length - 1] ?? "";
	if (operation.op === "set") {
		setPathValue(parent, key, operation.value);
		return;
	}
	const current = getPathValue(parent, key);
	if (!Array.isArray(current)) {
		throw new Error(
			`Cleanup patch ${operation.op} requires an array target: ${operation.path.join(".")}`,
		);
	}
	if (operation.op === "append") {
		current.push(operation.value);
		return;
	}
	const index = current.findIndex(
		(item) => JSON.stringify(item) === JSON.stringify(operation.value),
	);
	if (index >= 0) {
		current.splice(index, 1);
	}
}

function parentForPath(
	target: Record<string, unknown>,
	path: string[],
): Record<string, unknown> | unknown[] {
	let value: unknown = target;
	for (const segment of path.slice(0, -1)) {
		if (Array.isArray(value)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= value.length) {
				throw new Error(`Invalid cleanup patch array path: ${path.join(".")}`);
			}
			value = value[index];
			continue;
		}
		if (!isRecord(value)) {
			throw new Error(`Invalid cleanup patch path: ${path.join(".")}`);
		}
		value = value[segment];
	}
	if (!isRecord(value) && !Array.isArray(value)) {
		throw new Error(`Invalid cleanup patch parent: ${path.join(".")}`);
	}
	return value;
}

function getPathValue(
	parent: Record<string, unknown> | unknown[],
	key: string,
): unknown {
	return Array.isArray(parent) ? parent[Number(key)] : parent[key];
}

function setPathValue(
	parent: Record<string, unknown> | unknown[],
	key: string,
	value: unknown,
): void {
	if (Array.isArray(parent)) {
		const index = Number(key);
		if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
			throw new Error(`Invalid cleanup patch array index: ${key}`);
		}
		parent[index] = value;
		return;
	}
	parent[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function domainFromSender(value: string): string {
	const domain = value.split("@").at(-1) ?? value;
	return domain.trim().toLowerCase();
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=+-]+$/.test(value)
		? value
		: `'${value.replace(/'/g, "'\\''")}'`;
}

function providerFileStem(context: CliContext, name: string): string {
	return `${context.config.provider}-${name}`;
}

function providerFileName(context: CliContext, name: string): string {
	return `${providerFileStem(context, name)}.json`;
}

function compactRoutePlanForStorage(
	plan: RoutePlan,
	cleanupPlan: OutlookCleanupPlan,
): unknown {
	if (!cleanupPlan.artifacts.compactRoutePlans) {
		return plan;
	}
	return {
		...plan,
		routeCount: plan.route.length,
		skipCount: plan.skip.length,
		route: plan.route.map((action) => ({
			messageId: action.messageId,
			targetSegments: action.targetSegments,
			labelNames: action.labelNames,
			markRead: action.markRead,
			reason: action.reason,
		})),
		skip: plan.skip,
	};
}

function hasAny(text: string, values: string[]): boolean {
	return values.some((value) => text.includes(value));
}

function displayPath(segments: string[]): string {
	return segments.join(" > ");
}

function pathKey(segments: string[]): string {
	return segments.join("/");
}

function last(values: string[]): string {
	return values[values.length - 1] ?? "";
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function normalizeWorkspaceFilters(filters: unknown[]): MailRule[] {
	return filters
		.filter(
			(filter): filter is Record<string, unknown> =>
				typeof filter === "object" && filter !== null && !Array.isArray(filter),
		)
		.map((filter) => ({
			id: stringValue(filter.id, filter.ID, filter.name, filter.Name),
			name: stringValue(filter.name, filter.Name, filter.id, filter.ID),
			enabled: filter.enabled !== false,
			conditions: stringArray(filter.conditions, filter.Conditions),
			actions: stringArray(filter.actions, filter.Actions),
		}));
}

function stringValue(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) {
			return value;
		}
	}
	return "";
}

function stringArray(...values: unknown[]): string[] {
	for (const value of values) {
		if (Array.isArray(value)) {
			return value.filter((item): item is string => typeof item === "string");
		}
		if (typeof value === "string" && value.trim()) {
			return [value];
		}
	}
	return [];
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

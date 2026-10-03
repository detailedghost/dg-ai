import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	getBooleanFlag,
	getListFlag,
	getNumberFlag,
	getStringFlag,
} from "../cli/args";
import { workspaceDirForContext, type CliContext } from "../cli/context";
import { printJson } from "../cli/output";
import {
	createMailProviderClient,
	resolveProvider,
} from "../providers/factory";
import type {
	CreateMailFilterInput,
	MailProvider,
	MailProviderClient,
	MailRule,
} from "../providers/types";
import {
	readJsonFileIfExists as readJsonIfExists,
	writeJsonFile as writeJson,
} from "../utils/json";
import {
	preferredFilterPrefix,
	type FilterNamingConvention,
} from "../workspace/filter-naming";
import {
	folderDisplayName,
	isArchiveFolderName,
	isFilterRecommendationTarget,
	resolveFolder,
} from "../workspace/folders";
import {
	readFilterNamingConventions,
	readFilters,
	readFolders,
	workspacePaths,
	type WorkspacePaths,
} from "../workspace/store";

type FilterRecommendationRow = {
	domain?: string;
	targetFolder?: string;
	count?: number;
	safeForDomainFilter?: boolean;
	warning?: string;
};

type FilterPlanItem = {
	domain: string;
	targetFolder: string;
	targetFolderId: string;
	count: number;
	filterName: string;
	sieve: string;
};

type FilterApplyPlan = {
	kind: "workspace-filter-apply-plan";
	createdAt: string;
	dir: string;
	sourcePath: string;
	sourcePaths: string[];
	minCount: number;
	eligible: number;
	create: FilterPlanItem[];
	existing: FilterPlanItem[];
	blocked: {
		domain: string;
		targetFolder: string;
		count: number;
		reason: string;
	}[];
	planFingerprint: string;
};

export async function applyRecommendedFilters(
	context: CliContext,
): Promise<void> {
	const pathsList = getWorkspacePaths(context);
	const paths = pathsList[0];
	const dryRun = getBooleanFlag(context.args.flags, "dry-run");
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	if (dryRun && confirm) {
		throw new Error(
			"filters apply accepts either --dry-run or --confirm, not both",
		);
	}
	if (!dryRun && !confirm) {
		throw new Error("filters apply requires --dry-run or --confirm");
	}

	if (dryRun) {
		const savedFilters = await readFilters(paths);
		const summary = await dryRunFilterApply(pathsList, savedFilters, context);
		printJson(summary);
		return;
	}

	const provider = resolveProvider(
		context.config,
		getStringFlag(context.args.flags, "provider"),
	);
	const client = createMailProviderClient(context.config, provider);
	try {
		const summary = await applyFilterMutations(pathsList, client, context);
		printJson(summary);
	} finally {
		await client.close?.();
	}
}

async function dryRunFilterApply(
	pathsList: WorkspacePaths[],
	existingFilters: unknown[],
	context: CliContext,
): Promise<unknown> {
	const paths = pathsList[0];
	const plan = await buildFilterApplyPlan(
		pathsList,
		normalizeExistingFilters(existingFilters),
		context,
	);
	await writeJson(join(paths.plansDir, "filter-apply-plan.json"), plan);
	const summary = filterSummary(plan, true, false, undefined);
	await writeJson(join(paths.reportsDir, "filter-dry-run.json"), summary);
	return summary;
}

async function applyFilterMutations(
	pathsList: WorkspacePaths[],
	client: MailProviderClient,
	context: CliContext,
): Promise<unknown> {
	const paths = pathsList[0];
	const recommendationFingerprint = await filterRecommendationFingerprint(
		pathsList,
		context,
	);
	const dryRun = await readJsonIfExists<{
		dryRun?: boolean;
		planFingerprint?: string;
	}>(join(paths.reportsDir, "filter-dry-run.json"));
	if (!dryRun?.dryRun || !dryRun.planFingerprint) {
		throw new Error(
			"filters apply --confirm requires a successful filters apply --dry-run report for the current workspace",
		);
	}
	if (dryRun.planFingerprint !== recommendationFingerprint) {
		throw new Error(
			"filters apply --confirm refused because the recommendation plan changed after the last dry run; run filters apply --dry-run again",
		);
	}

	const liveFilters = await client.listFilters();
	const plan = await buildFilterApplyPlan(pathsList, liveFilters, context);
	if (!client.createFilter && plan.create.length > 0) {
		throw new Error(
			`${client.provider} filter apply is not supported by this client`,
		);
	}
	const created: {
		name: string;
		domain: string;
		targetFolder: string;
		count: number;
		id: string;
	}[] = [];
	for (const item of plan.create) {
		const filter = await client.createFilter?.(
			filterCreateInput(client.provider, item),
		);
		if (!filter) {
			continue;
		}
		created.push({
			name: item.filterName,
			domain: item.domain,
			targetFolder: item.targetFolder,
			count: item.count,
			id: filter.id,
		});
	}

	const now = new Date().toISOString();
	const auditPath = join(
		paths.auditDir,
		`filter-apply-${now.replace(/[:.]/g, "-")}.json`,
	);
	const audit = {
		kind: "workspace-filter-apply-audit",
		createdAt: now,
		mutated: true,
		created,
		existing: plan.existing.map((item) => ({
			domain: item.domain,
			targetFolder: item.targetFolder,
			count: item.count,
			filterName: item.filterName,
		})),
		blocked: plan.blocked,
	};
	await writeJson(auditPath, audit);

	const summary = filterSummary(
		{
			...plan,
			create: created.map((item) => ({
				domain: item.domain,
				targetFolder: item.targetFolder,
				targetFolderId: "",
				count: item.count,
				filterName: item.name,
				sieve: "",
			})),
		},
		false,
		true,
		auditPath,
	);
	await writeJson(join(paths.reportsDir, "filter-apply.json"), summary);
	return summary;
}

async function buildFilterApplyPlan(
	pathsList: WorkspacePaths[],
	existingFilters: MailRule[],
	context: CliContext,
): Promise<FilterApplyPlan> {
	const paths = pathsList[0];
	const minCount = getNumberFlag(context.args.flags, "min-count", 1);
	const onlyDomain = getStringFlag(context.args.flags, "domain");
	const onlyTarget = getStringFlag(context.args.flags, "target-folder");
	const [folders, namingConventions, recommendationsByPath] = await Promise.all(
		[
			readFolders(paths),
			readFilterNamingConventions(paths).catch(() => []),
			Promise.all(
				pathsList.map(async (workspace) => ({
					paths: workspace,
					recommendations: await readFilterRecommendations(workspace),
				})),
			),
		],
	);
	const blocked: FilterApplyPlan["blocked"] = [];
	const candidates = new Map<string, FilterPlanItem>();

	const recommendationRows = recommendationsByPath.flatMap(
		(group) => group.recommendations,
	);
	const preThresholdTargetsByDomain = new Map<string, Set<string>>();
	for (const row of recommendationRows) {
		const domain = normalizeDomain(row.domain ?? "");
		const targetFolder = row.targetFolder ?? "";
		const count = row.count ?? 0;
		if (!domain || !targetFolder) {
			continue;
		}
		if (onlyDomain && domain !== normalizeDomain(onlyDomain)) {
			continue;
		}
		if (
			onlyTarget &&
			normalizeName(targetFolder) !== normalizeName(onlyTarget)
		) {
			continue;
		}
		if (
			isArchiveFolderName(targetFolder) ||
			!isFilterRecommendationTarget(targetFolder) ||
			!isSafeDomain(domain)
		) {
			continue;
		}
		const targets =
			preThresholdTargetsByDomain.get(domain) ?? new Set<string>();
		targets.add(normalizeName(targetFolder));
		preThresholdTargetsByDomain.set(domain, targets);
	}

	for (const row of recommendationRows) {
		const domain = normalizeDomain(row.domain ?? "");
		const targetFolder = row.targetFolder ?? "";
		const count = row.count ?? 0;
		if (!domain || !targetFolder) {
			continue;
		}
		if (onlyDomain && domain !== normalizeDomain(onlyDomain)) {
			continue;
		}
		if (
			onlyTarget &&
			normalizeName(targetFolder) !== normalizeName(onlyTarget)
		) {
			continue;
		}
		if ((preThresholdTargetsByDomain.get(domain)?.size ?? 0) > 1) {
			blocked.push({
				domain,
				targetFolder,
				count,
				reason:
					"Domain has multiple target folders across selected workspaces; use narrower conditions instead of a domain-only filter.",
			});
			continue;
		}
		const blockReason = blockedReason(
			row,
			domain,
			targetFolder,
			count,
			minCount,
		);
		if (blockReason) {
			blocked.push({ domain, targetFolder, count, reason: blockReason });
			continue;
		}
		const folder = resolveFolder(folders, targetFolder, { purpose: "target" });
		const displayName = folderDisplayName(folder);
		const item: FilterPlanItem = {
			domain,
			targetFolder: displayName,
			targetFolderId: folder.id,
			count:
				count +
				(candidates.get(`${domain}\u0000${normalizeName(displayName)}`)
					?.count ?? 0),
			filterName: filterName(domain, displayName, namingConventions),
			sieve: sieveForDomain(domain, displayName),
		};
		candidates.set(
			`${item.domain}\u0000${normalizeName(item.targetFolder)}`,
			item,
		);
	}

	const targetsByDomain = new Map<string, Set<string>>();
	for (const item of candidates.values()) {
		const targets = targetsByDomain.get(item.domain) ?? new Set<string>();
		targets.add(normalizeName(item.targetFolder));
		targetsByDomain.set(item.domain, targets);
	}
	for (const item of [...candidates.values()]) {
		if ((targetsByDomain.get(item.domain)?.size ?? 0) <= 1) {
			continue;
		}
		candidates.delete(
			`${item.domain}\u0000${normalizeName(item.targetFolder)}`,
		);
		blocked.push({
			domain: item.domain,
			targetFolder: item.targetFolder,
			count: item.count,
			reason:
				"Domain has multiple target folders across selected workspaces; use narrower conditions instead of a domain-only filter.",
		});
	}

	const create: FilterPlanItem[] = [];
	const existing: FilterPlanItem[] = [];
	for (const item of [...candidates.values()].sort(sortPlanItems)) {
		if (hasExistingFilter(existingFilters, item)) {
			existing.push(item);
		} else {
			create.push(item);
		}
	}

	const planFingerprint = filterPlanFingerprint(
		[...candidates.values()].sort(sortPlanItems),
	);
	return {
		kind: "workspace-filter-apply-plan",
		createdAt: new Date().toISOString(),
		dir: paths.dir,
		sourcePath: join(paths.plansDir, "filter-recommendations.json"),
		sourcePaths: pathsList.map((workspace) =>
			join(workspace.plansDir, "filter-recommendations.json"),
		),
		minCount,
		eligible: candidates.size,
		create,
		existing,
		blocked: blocked.sort(
			(left, right) =>
				right.count - left.count || left.domain.localeCompare(right.domain),
		),
		planFingerprint,
	};
}

async function readFilterRecommendations(
	paths: WorkspacePaths,
): Promise<FilterRecommendationRow[]> {
	const file = await readJsonIfExists<{
		filterRecommendations?: FilterRecommendationRow[];
		archiveFollowups?: FilterRecommendationRow[];
	}>(join(paths.plansDir, "filter-recommendations.json"));
	if (!file) {
		throw new Error(
			`filter recommendations not found: ${join(paths.plansDir, "filter-recommendations.json")}; run recommend filters first`,
		);
	}
	return [
		...(Array.isArray(file.filterRecommendations)
			? file.filterRecommendations
			: []),
		...(Array.isArray(file.archiveFollowups) ? file.archiveFollowups : []),
	];
}

async function filterRecommendationFingerprint(
	pathsList: WorkspacePaths[],
	context: CliContext,
): Promise<string> {
	const plan = await buildFilterApplyPlan(pathsList, [], context);
	return plan.planFingerprint;
}

function blockedReason(
	row: FilterRecommendationRow,
	domain: string,
	targetFolder: string,
	count: number,
	minCount: number,
): string | undefined {
	if (!row.safeForDomainFilter) {
		return (
			row.warning ?? "Recommendation is not safe for a domain-only filter."
		);
	}
	if (count < minCount) {
		return `Recommendation count ${count} is below --min-count ${minCount}.`;
	}
	if (isArchiveFolderName(targetFolder)) {
		return "Archive filters are intentionally blocked; use concrete folders or Spam.";
	}
	if (!isFilterRecommendationTarget(targetFolder)) {
		return "Target folder is not eligible for automatic filter creation.";
	}
	if (!isSafeDomain(domain)) {
		return "Domain is not valid for a domain-only Sieve filter.";
	}
	return undefined;
}

function filterSummary(
	plan: FilterApplyPlan,
	dryRun: boolean,
	mutated: boolean,
	auditPath?: string,
): unknown {
	return {
		kind: "workspace-filter-apply-summary",
		dryRun,
		mutated,
		createdAt: new Date().toISOString(),
		dir: plan.dir,
		sourcePath: plan.sourcePath,
		sourcePaths: plan.sourcePaths,
		minCount: plan.minCount,
		eligible: plan.eligible,
		create: plan.create.length,
		existing: plan.existing.length,
		blocked: plan.blocked.length,
		planFingerprint: plan.planFingerprint,
		auditPath,
		filters: plan.create.map((item) => ({
			domain: item.domain,
			targetFolder: item.targetFolder,
			count: item.count,
			filterName: item.filterName,
		})),
		existingFilters: plan.existing.map((item) => ({
			domain: item.domain,
			targetFolder: item.targetFolder,
			count: item.count,
			filterName: item.filterName,
		})),
		blockedRecommendations: plan.blocked.slice(0, 50),
		warning: dryRun
			? "Dry run only. No provider filters were created."
			: undefined,
	};
}

function filterCreateInput(
	provider: MailProvider,
	item: FilterPlanItem,
): CreateMailFilterInput {
	if (provider === "gmail") {
		return {
			name: item.filterName,
			criteria: { from: item.domain },
			action: {
				addLabelIds: [item.targetFolderId],
				removeLabelIds: ["INBOX"],
			},
			enabled: true,
		};
	}
	return {
		name: item.filterName,
		sieve: item.sieve,
		enabled: true,
	};
}

function hasExistingFilter(filters: MailRule[], item: FilterPlanItem): boolean {
	const expectedName = normalizeName(item.filterName);
	const domain = normalizeDomain(item.domain);
	const target = normalizeName(item.targetFolder);
	return filters.some((filter) => {
		if (normalizeName(filter.name) === expectedName) {
			return true;
		}
		const text = [filter.name, ...filter.conditions, ...filter.actions]
			.join("\n")
			.toLowerCase();
		return text.includes(domain) && text.includes(target);
	});
}

function normalizeExistingFilters(filters: unknown[]): MailRule[] {
	return filters.filter(isRecord).map((filter) => ({
		id: stringValue(filter.id, filter.ID, filter.name, filter.Name),
		name: stringValue(filter.name, filter.Name, filter.id, filter.ID),
		enabled: filter.enabled !== false,
		conditions: stringArray(
			filter.conditions,
			filter.Conditions,
			filter.actions,
			filter.Actions,
		),
		actions: stringArray(
			filter.actions,
			filter.Actions,
			filter.conditions,
			filter.Conditions,
		),
	}));
}

function sieveForDomain(domain: string, targetFolder: string): string {
	return [
		'require ["fileinto", "imap4flags"];',
		"# Generated by email-organizer.",
		`if address :domain :is "From" ${sieveString(domain)} {`,
		`  fileinto ${sieveString(targetFolder)};`,
		'  addflag "\\\\Seen";',
		"  stop;",
		"}",
	].join("\n");
}

function filterName(
	domain: string,
	targetFolder: string,
	namingConventions: FilterNamingConvention[],
): string {
	return `${preferredFilterPrefix(namingConventions, targetFolder, fallbackFilterNamePrefix(targetFolder))} - ${domain}`.slice(
		0,
		100,
	);
}

function fallbackFilterNamePrefix(targetFolder: string): string {
	switch (normalizeName(targetFolder)) {
		case "spam":
			return "Spam";
		default:
			return titleCaseFolder(targetFolder);
	}
}

function titleCaseFolder(value: string): string {
	return value
		.trim()
		.split(/[\s-]+/)
		.filter(Boolean)
		.map(
			(part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`,
		)
		.join(" ");
}

function filterPlanFingerprint(items: FilterPlanItem[]): string {
	const stable = items.map((item) => ({
		domain: item.domain,
		targetFolder: item.targetFolder,
		count: item.count,
		filterName: item.filterName,
		sieve: item.sieve,
	}));
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function sortPlanItems(left: FilterPlanItem, right: FilterPlanItem): number {
	return (
		right.count - left.count ||
		left.targetFolder.localeCompare(right.targetFolder) ||
		left.domain.localeCompare(right.domain)
	);
}

function isSafeDomain(domain: string): boolean {
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
		domain,
	);
}

function normalizeDomain(value: string): string {
	return value.trim().toLowerCase();
}

function normalizeName(value: string): string {
	return value.trim().toLowerCase();
}

function sieveString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function getWorkspaceDir(context: CliContext): string {
	const explicit = getStringFlag(context.args.flags, "dir");
	if (explicit) {
		return explicit;
	}
	return workspaceDirForContext(context);
}

function getWorkspacePaths(context: CliContext): WorkspacePaths[] {
	const dirs = getListFlag(context.args.flags, "dirs") ?? [
		getWorkspaceDir(context),
	];
	if (dirs.length === 0) {
		throw new Error("filters apply requires at least one workspace directory");
	}
	return dirs.map((dir) => workspacePaths(dir));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

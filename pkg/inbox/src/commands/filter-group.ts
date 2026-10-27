import { createHash } from "node:crypto";
import { join } from "node:path";
import { getBooleanFlag, getStringFlag } from "../cli/args";
import { workspaceDirForContext, type CliContext } from "../cli/context";
import { printJson } from "../cli/output";
import { createProtonMailClient } from "../protonmail/client";
import type { ProtonFilter, ProtonFolder } from "../protonmail/types";
import {
	readJsonFileIfExists as readJsonIfExists,
	writeJsonFile as writeJson,
} from "../utils/json";
import {
	declaredFiltersPath,
	editDeclaredFilters,
	removeDeclaredFilters,
	upsertDeclaredFilter,
} from "../features/filter-policy/store";
import { isDeclaredOnlyId, readDeclaredWithUnsynced } from "./filter-declared";
import { folderDisplayName, resolveFolder } from "../workspace/folders";
import { readFilters, readFolders, workspacePaths } from "../workspace/store";

type GeneratedFilter = {
	id: string;
	name: string;
	domain: string;
	targetFolder: string;
};

type GroupPlanItem = {
	targetFolder: string;
	filterName: string;
	action: "create" | "update";
	existingFilterId?: string;
	generatedFilterIds: string[];
	domains: string[];
	sieve: string;
};

type FilterGroupPlan = {
	kind: "workspace-filter-group-plan";
	dryRun: boolean;
	mutated: boolean;
	dir: string;
	groups: GroupPlanItem[];
	delete: number;
	planFingerprint: string;
	warning?: string;
	auditPath?: string;
};

const defaultGroupNames: Record<string, string> = {
	invoice: "Fin - Invoices",
	spam: "Spam - Marketing",
	hunt: "Hunt - EDC",
};

export async function groupGeneratedFilters(
	context: CliContext,
): Promise<void> {
	const paths = workspacePaths(workspaceDirForContext(context));
	const dryRun = getBooleanFlag(context.args.flags, "dry-run");
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	if (dryRun && confirm) {
		throw new Error(
			"filters group accepts either --dry-run or --confirm, not both",
		);
	}
	if (!dryRun && !confirm) {
		throw new Error("filters group requires --dry-run or --confirm");
	}

	if (dryRun) {
		const folders = await readFolders(paths);
		if (context.config.protonmail.liveBrowser) {
			const client = createProtonMailClient(context.config);
			try {
				const plan = buildGroupPlan(
					paths.dir,
					folders,
					await readDeclaredWithUnsynced(paths.dir, await client.listFilters()),
					context,
					{ dryRun: true },
				);
				await writeJson(join(paths.plansDir, "filter-group-plan.json"), plan);
				await writeJson(
					join(paths.reportsDir, "filter-group-dry-run.json"),
					summarizeGroupPlan(plan),
				);
				printJson(summarizeGroupPlan(plan));
				return;
			} finally {
				await client.close?.();
			}
		}
		const savedFilters = await readFilters(paths);
		const plan = buildGroupPlan(
			paths.dir,
			folders,
			await readDeclaredWithUnsynced(paths.dir, normalizeFilters(savedFilters)),
			context,
			{ dryRun: true },
		);
		await writeJson(join(paths.plansDir, "filter-group-plan.json"), plan);
		await writeJson(
			join(paths.reportsDir, "filter-group-dry-run.json"),
			summarizeGroupPlan(plan),
		);
		printJson(summarizeGroupPlan(plan));
		return;
	}

	const client = createProtonMailClient(context.config);
	try {
		const dryRunReport = await readJsonIfExists<{
			dryRun?: boolean;
			planFingerprint?: string;
		}>(join(paths.reportsDir, "filter-group-dry-run.json"));
		if (!dryRunReport?.dryRun || !dryRunReport.planFingerprint) {
			throw new Error(
				"filters group --confirm requires a successful filters group --dry-run report",
			);
		}
		const [folders, rawLiveFilters, liveFolders] = await Promise.all([
			readFolders(paths),
			client.listFilters(),
			client.listFolders(),
		]);
		const liveFilters = await readDeclaredWithUnsynced(paths.dir, rawLiveFilters);
		const plan = buildGroupPlan(paths.dir, folders, liveFilters, context, {
			dryRun: false,
		});
		if (plan.planFingerprint !== dryRunReport.planFingerprint) {
			throw new Error(
				"filters group --confirm refused because the group plan changed after the last dry run; run filters group --dry-run again",
			);
		}
		const auditPath = await applyGroupPlan(
			plan,
			liveFilters,
			liveFolders,
			paths.dir,
		);
		const summary = summarizeGroupPlan({ ...plan, mutated: true, auditPath });
		await writeJson(join(paths.reportsDir, "filter-group.json"), summary);
		printJson(summary);
	} finally {
		await client.close?.();
	}
}

function buildGroupPlan(
	dir: string,
	folders: ProtonFolder[],
	filters: ProtonFilter[],
	context: CliContext,
	options: { dryRun: boolean },
): FilterGroupPlan {
	const groups = groupTargets(context);
	const generated = filters
		.filter((filter) => !isDeclaredOnlyId(filter.id))
		.map(parseLegacyGeneratedFilter)
		.filter((filter): filter is GeneratedFilter => filter !== undefined);
	const planGroups: GroupPlanItem[] = [];

	for (const group of groups) {
		const folder = resolveFolder(folders, group.targetFolder, {
			purpose: "target",
		});
		const targetFolder = folderDisplayName(folder);
		const matching = generated
			.filter(
				(filter) => normalize(filter.targetFolder) === normalize(targetFolder),
			)
			.sort((left, right) => left.domain.localeCompare(right.domain));
		if (matching.length === 0) {
			continue;
		}
		const existing = filters.find(
			(filter) => normalize(filter.name) === normalize(group.filterName),
		);
		const domains = [
			...new Set(matching.map((filter) => filter.domain.toLowerCase())),
		].sort();
		planGroups.push({
			targetFolder,
			filterName: group.filterName,
			action: existing ? "update" : "create",
			...(existing ? { existingFilterId: existing.id } : {}),
			generatedFilterIds: matching.map((filter) => filter.id),
			domains,
			sieve: existing
				? mergeSieve(filterSieve(existing), targetFolder, domains)
				: sieveForDomains(domains, targetFolder),
		});
	}

	const sortedGroups = planGroups.sort((left, right) =>
		left.targetFolder.localeCompare(right.targetFolder),
	);
	return {
		kind: "workspace-filter-group-plan",
		dryRun: options.dryRun,
		mutated: false,
		dir,
		groups: sortedGroups,
		delete: sortedGroups.reduce(
			(sum, group) => sum + group.generatedFilterIds.length,
			0,
		),
		planFingerprint: groupPlanFingerprint(sortedGroups),
		warning: options.dryRun
			? "Dry run only. No Proton filters were created, updated, or deleted."
			: undefined,
	};
}

async function applyGroupPlan(
	plan: FilterGroupPlan,
	liveFilters: ProtonFilter[],
	liveFolders: ProtonFolder[],
	dir: string,
): Promise<string> {
	const byId = new Map(liveFilters.map((filter) => [filter.id, filter]));
	const updated: {
		id?: string;
		name: string;
		action: string;
		domains: string[];
		deletedFilterIds: string[];
	}[] = [];

	await editDeclaredFilters({
		path: declaredFiltersPath(dir),
		filters: liveFilters,
		folders: liveFolders,
		edit(file) {
			for (const group of plan.groups) {
				const existing = group.existingFilterId
					? byId.get(group.existingFilterId)
					: undefined;
				if (group.existingFilterId && !existing) {
					throw new Error(
						`Existing grouped filter missing from live snapshot: ${group.filterName}`,
					);
				}
				upsertDeclaredFilter(
					file,
					{
						name: group.filterName,
						enabled: existing?.enabled ?? true,
						sieve: group.sieve,
						...(existing && !isDeclaredOnlyId(existing.id)
							? { protonId: existing.id }
							: {}),
					},
					existing?.id,
				);
				removeDeclaredFilters(file, group.generatedFilterIds);
			}
		},
	});
	for (const group of plan.groups) {
		const filterId = group.existingFilterId;
		updated.push({
			id: filterId,
			name: group.filterName,
			action: group.action,
			domains: group.domains,
			deletedFilterIds: group.generatedFilterIds,
		});
	}

	const auditPath = join(
		plan.dir,
		"audit",
		`filter-group-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	await writeJson(auditPath, {
		kind: "workspace-filter-group-audit",
		createdAt: new Date().toISOString(),
		mutated: true,
		updated,
		planFingerprint: plan.planFingerprint,
	});
	return auditPath;
}

function groupTargets(
	context: CliContext,
): { targetFolder: string; filterName: string }[] {
	return [
		{
			targetFolder: "invoice",
			filterName: getStringFlag(
				context.args.flags,
				"invoice-name",
				defaultGroupNames.invoice,
			),
		},
		{
			targetFolder: "Spam",
			filterName: getStringFlag(
				context.args.flags,
				"spam-name",
				defaultGroupNames.spam,
			),
		},
		{
			targetFolder: "hunt",
			filterName: getStringFlag(
				context.args.flags,
				"hunt-name",
				defaultGroupNames.hunt,
			),
		},
	];
}

function parseLegacyGeneratedFilter(
	filter: ProtonFilter,
): GeneratedFilter | undefined {
	const match = filter.name.match(/^Email Organizer: (.+) -> (.+)$/);
	if (!match) {
		return undefined;
	}
	return {
		id: filter.id,
		name: filter.name,
		domain: match[1].trim().toLowerCase(),
		targetFolder: match[2].trim(),
	};
}

function summarizeGroupPlan(plan: FilterGroupPlan): unknown {
	return {
		kind: "workspace-filter-group-summary",
		dryRun: plan.dryRun,
		mutated: plan.mutated,
		dir: plan.dir,
		groups: plan.groups.length,
		create: plan.groups.filter((group) => group.action === "create").length,
		update: plan.groups.filter((group) => group.action === "update").length,
		delete: plan.delete,
		planFingerprint: plan.planFingerprint,
		filters: plan.groups.map((group) => ({
			name: group.filterName,
			action: group.action,
			targetFolder: group.targetFolder,
			domains: group.domains,
			deletes: group.generatedFilterIds.length,
		})),
		warning: plan.warning,
		auditPath: plan.auditPath,
	};
}

function mergeSieve(
	existingSieve: string,
	targetFolder: string,
	domains: string[],
): string {
	const normalizedExisting = existingSieve.toLowerCase();
	const missingDomains = domains.filter(
		(domain) => !normalizedExisting.includes(domain),
	);
	if (missingDomains.length === 0) {
		return existingSieve;
	}
	return `${ensureSieveRequirements(existingSieve).trimEnd()}\n${domainBlock(missingDomains, targetFolder)}\n`;
}

function sieveForDomains(domains: string[], targetFolder: string): string {
	return [
		'require ["fileinto", "imap4flags"];',
		"# email-organizer grouped filter",
		domainBlock(domains, targetFolder),
	].join("\n");
}

function domainBlock(domains: string[], targetFolder: string): string {
	return [
		`if address :domain :is "From" ${sieveStringList(domains)} {`,
		`  fileinto ${sieveString(targetFolder)};`,
		'  addflag "\\\\Seen";',
		"  stop;",
		"}",
	].join("\n");
}

function ensureSieveRequirements(sieve: string): string {
	const normalized = sieve.toLowerCase();
	if (normalized.includes("fileinto") && normalized.includes("imap4flags")) {
		return sieve;
	}
	return `require ["fileinto", "imap4flags"];\n${sieve}`;
}

function filterSieve(filter: ProtonFilter): string {
	return filter.conditions[0] ?? filter.actions[0] ?? "";
}

function sieveStringList(values: string[]): string {
	return values.length === 1
		? sieveString(values[0])
		: `[${values.map(sieveString).join(", ")}]`;
}

function sieveString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function groupPlanFingerprint(groups: GroupPlanItem[]): string {
	const stable = groups.map((group) => ({
		targetFolder: group.targetFolder,
		filterName: group.filterName,
		action: group.action,
		existingFilterId: group.existingFilterId,
		generatedFilterIds: group.generatedFilterIds.slice().sort(),
		domains: group.domains,
		sieve: group.sieve,
	}));
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function normalizeFilters(filters: unknown[]): ProtonFilter[] {
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

function normalize(value: string): string {
	return value.trim().toLowerCase();
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

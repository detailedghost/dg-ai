import { createHash } from "node:crypto";
import { join } from "node:path";
import { sortBy, uniq } from "lodash-es";
import { getBooleanFlag, getStringFlag } from "../../cli/args";
import { workspaceDirForContext, type CliContext } from "../../cli/context";
import { printJson } from "../../cli/output";
import type { RouteProfileConfig } from "../../config/types";
import { createProtonMailClient } from "../../protonmail/client";
import type {
	ProtonFilter,
	ProtonFolder,
	ProtonMailClient,
} from "../../protonmail/types";
import { readJsonFileIfExists, writeJsonFile } from "../../utils/json";
import { folderDisplayName, resolveFolder } from "../../workspace/folders";
import {
	readFilters,
	readFolders,
	writeFilters,
	writeFolders,
	workspacePaths,
} from "../../workspace/store";

type RoutePlan = {
	kind: "workspace-filter-route-plan";
	dryRun: boolean;
	mutated: boolean;
	dir: string;
	profile: string;
	folderName: string;
	filterName: string;
	folderAction: "create" | "reuse";
	filterAction: "create" | "update";
	existingFolderId?: string;
	existingFilterId?: string;
	domainFilters: string[];
	subjectDomainFilters: { domain: string; subjectContains: string[] }[];
	sieve: string;
	planFingerprint: string;
	warning?: string;
	auditPath?: string;
};

export async function routeProfileFilter(context: CliContext): Promise<void> {
	const paths = workspacePaths(workspaceDirForContext(context));
	const profileName = getStringFlag(context.args.flags, "profile", "updates");
	const profile = context.config.routeProfiles[profileName];
	if (!profile) {
		throw new Error(
			`route profile not found: ${profileName}; add it to ${context.config.configHome}/route-profiles.json`,
		);
	}
	const dryRun = getBooleanFlag(context.args.flags, "dry-run");
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	if (dryRun && confirm) {
		throw new Error(
			"filters route accepts either --dry-run or --confirm, not both",
		);
	}
	if (!dryRun && !confirm) {
		throw new Error("filters route requires --dry-run or --confirm");
	}

	if (dryRun) {
		const plan = await buildRoutePlanForDryRun(context, profileName, profile);
		await writeJsonFile(join(paths.plansDir, "filter-route-plan.json"), plan);
		await writeJsonFile(
			join(paths.reportsDir, "filter-route-dry-run.json"),
			summarizeRoutePlan(plan),
		);
		printJson(summarizeRoutePlan(plan));
		return;
	}

	const dryRunReport = await readJsonFileIfExists<{
		dryRun?: boolean;
		planFingerprint?: string;
	}>(join(paths.reportsDir, "filter-route-dry-run.json"));
	if (!dryRunReport?.dryRun || !dryRunReport.planFingerprint) {
		throw new Error(
			"filters route --confirm requires a successful filters route --dry-run report",
		);
	}
	const client = createProtonMailClient(context.config);
	try {
		const [folders, filters] = await Promise.all([
			client.listFolders(),
			client.listFilters(),
		]);
		const plan = buildRoutePlan(
			paths.dir,
			profileName,
			profile,
			folders,
			filters,
			{ dryRun: false },
		);
		if (plan.planFingerprint !== dryRunReport.planFingerprint) {
			throw new Error(
				"filters route --confirm refused because the route plan changed after the last dry run; run filters route --dry-run again",
			);
		}
		const auditPath = await applyRoutePlan(plan, client);
		const [refreshedFolders, refreshedFilters] = await Promise.all([
			client.listFolders(),
			client.listFilters(),
		]);
		await Promise.all([
			writeFolders(paths, refreshedFolders),
			writeFilters(
				paths,
				refreshedFilters,
				context.config.protonmail.snippetLength,
			),
		]);
		const summary = summarizeRoutePlan({ ...plan, mutated: true, auditPath });
		await writeJsonFile(join(paths.reportsDir, "filter-route.json"), summary);
		printJson(summary);
	} finally {
		await client.close?.();
	}
}

async function buildRoutePlanForDryRun(
	context: CliContext,
	profileName: string,
	profile: RouteProfileConfig,
): Promise<RoutePlan> {
	const paths = workspacePaths(workspaceDirForContext(context));
	if (context.config.protonmail.liveBrowser) {
		const client = createProtonMailClient(context.config);
		try {
			const [folders, filters] = await Promise.all([
				client.listFolders(),
				client.listFilters(),
			]);
			return buildRoutePlan(paths.dir, profileName, profile, folders, filters, {
				dryRun: true,
			});
		} finally {
			await client.close?.();
		}
	}
	const [folders, savedFilters] = await Promise.all([
		readFolders(paths),
		readFilters(paths),
	]);
	return buildRoutePlan(
		paths.dir,
		profileName,
		profile,
		folders,
		normalizeFilters(savedFilters),
		{ dryRun: true },
	);
}

function buildRoutePlan(
	dir: string,
	profileName: string,
	profile: RouteProfileConfig,
	folders: ProtonFolder[],
	filters: ProtonFilter[],
	options: { dryRun: boolean },
): RoutePlan {
	validateRouteProfile(profileName, profile);
	const existingFolder = resolveFolder(folders, profile.folderName, {
		purpose: "target",
		allowMissing: true,
	});
	const folderName = existingFolder
		? folderDisplayName(existingFolder)
		: profile.folderName;
	const existingFilter = filters.find(
		(filter) => normalize(filter.name) === normalize(profile.filterName),
	);
	const planWithoutFingerprint = {
		kind: "workspace-filter-route-plan" as const,
		dryRun: options.dryRun,
		mutated: false,
		dir,
		profile: profileName,
		folderName,
		filterName: profile.filterName,
		folderAction: existingFolder ? ("reuse" as const) : ("create" as const),
		filterAction: existingFilter ? ("update" as const) : ("create" as const),
		...(existingFolder ? { existingFolderId: existingFolder.id } : {}),
		...(existingFilter ? { existingFilterId: existingFilter.id } : {}),
		domainFilters: normalizedDomains(profile.domainFilters ?? []),
		subjectDomainFilters: normalizedSubjectDomainFilters(
			profile.subjectDomainFilters ?? [],
		),
		sieve: routeSieve(profile, folderName),
		warning: options.dryRun
			? "Dry run only. No folders or Proton filters were changed."
			: undefined,
	};
	return {
		...planWithoutFingerprint,
		planFingerprint: routePlanFingerprint(planWithoutFingerprint),
	};
}

async function applyRoutePlan(
	plan: RoutePlan,
	client: ProtonMailClient,
): Promise<string> {
	const folder = plan.existingFolderId
		? {
				id: plan.existingFolderId,
				name: plan.folderName,
				type: "label" as const,
			}
		: await client.createFolder({ name: plan.folderName, type: "label" });

	if (plan.filterAction === "update" && plan.existingFilterId) {
		await client.updateFilter({
			id: plan.existingFilterId,
			name: plan.filterName,
			sieve: plan.sieve,
			enabled: true,
		});
	} else {
		await client.createFilter({
			name: plan.filterName,
			sieve: plan.sieve,
			enabled: true,
		});
	}

	const auditPath = join(
		plan.dir,
		"audit",
		`filter-route-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	await writeJsonFile(auditPath, {
		kind: "workspace-filter-route-audit",
		createdAt: new Date().toISOString(),
		mutated: true,
		profile: plan.profile,
		folder: {
			id: folder.id,
			name: folderDisplayName(folder),
			action: plan.folderAction,
		},
		filter: {
			name: plan.filterName,
			action: plan.filterAction,
		},
		domainFilters: plan.domainFilters,
		subjectDomainFilters: plan.subjectDomainFilters,
		planFingerprint: plan.planFingerprint,
	});
	return auditPath;
}

function routeSieve(profile: RouteProfileConfig, folderName: string): string {
	const rules = [
		...domainRules(normalizedDomains(profile.domainFilters ?? [])),
		...subjectDomainRules(
			normalizedSubjectDomainFilters(profile.subjectDomainFilters ?? []),
		),
	];
	return [
		'require ["fileinto", "imap4flags"];',
		"# email-organizer route profile",
		`if anyof(${rules.join(", ")}) {`,
		`  fileinto ${sieveString(folderName)};`,
		'  addflag "\\\\Seen";',
		"  stop;",
		"}",
	].join("\n");
}

function domainRules(domains: string[]): string[] {
	if (domains.length === 0) {
		return [];
	}
	return [`address :domain :is "From" ${sieveStringList(domains)}`];
}

function subjectDomainRules(
	rows: { domain: string; subjectContains: string[] }[],
): string[] {
	return rows.map(
		(row) =>
			`allof(address :domain :is "From" ${sieveString(row.domain)}, header :contains "Subject" ${sieveStringList(row.subjectContains)})`,
	);
}

function validateRouteProfile(name: string, profile: RouteProfileConfig): void {
	if (!profile.folderName?.trim()) {
		throw new Error(`route profile ${name} requires folderName`);
	}
	if (!profile.filterName?.trim()) {
		throw new Error(`route profile ${name} requires filterName`);
	}
	if (
		normalizedDomains(profile.domainFilters ?? []).length === 0 &&
		normalizedSubjectDomainFilters(profile.subjectDomainFilters ?? [])
			.length === 0
	) {
		throw new Error(
			`route profile ${name} requires at least one domain or subject-domain rule`,
		);
	}
}

function summarizeRoutePlan(plan: RoutePlan): unknown {
	return {
		kind: "workspace-filter-route-summary",
		dryRun: plan.dryRun,
		mutated: plan.mutated,
		dir: plan.dir,
		profile: plan.profile,
		folder: {
			name: plan.folderName,
			action: plan.folderAction,
		},
		filter: {
			name: plan.filterName,
			action: plan.filterAction,
		},
		domainFilters: plan.domainFilters.length,
		subjectDomainFilters: plan.subjectDomainFilters.length,
		planFingerprint: plan.planFingerprint,
		warning: plan.warning,
		auditPath: plan.auditPath,
	};
}

function routePlanFingerprint(
	plan: Omit<RoutePlan, "planFingerprint">,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				profile: plan.profile,
				folderName: plan.folderName,
				filterName: plan.filterName,
				folderAction: plan.folderAction,
				filterAction: plan.filterAction,
				existingFolderId: plan.existingFolderId,
				existingFilterId: plan.existingFilterId,
				domainFilters: plan.domainFilters,
				subjectDomainFilters: plan.subjectDomainFilters,
				sieve: plan.sieve,
			}),
		)
		.digest("hex");
}

function normalizedDomains(domains: string[]): string[] {
	return sortBy(
		uniq(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean)),
	);
}

function normalizedSubjectDomainFilters(
	rows: NonNullable<RouteProfileConfig["subjectDomainFilters"]>,
): { domain: string; subjectContains: string[] }[] {
	return rows
		.map((row) => ({
			domain: row.domain.trim().toLowerCase(),
			subjectContains: sortBy(
				uniq(row.subjectContains.map((value) => value.trim()).filter(Boolean)),
			),
		}))
		.filter((row) => row.domain && row.subjectContains.length > 0)
		.sort((left, right) => left.domain.localeCompare(right.domain));
}

function sieveStringList(values: string[]): string {
	return values.length === 1
		? sieveString(values[0])
		: `[${values.map(sieveString).join(", ")}]`;
}

function sieveString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

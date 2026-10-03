import { createHash } from "node:crypto";
import { join } from "node:path";
import { getBooleanFlag, getNumberFlag, getStringFlag } from "../cli/args";
import { workspaceDirForContext, type CliContext } from "../cli/context";
import { printJson } from "../cli/output";
import { redactText } from "../privacy/redact";
import { createProtonMailClient } from "../protonmail/client";
import type {
	ProtonFilter,
	ProtonFolder,
	ProtonMailClient,
} from "../protonmail/types";
import {
	readJsonFileIfExists as readJsonIfExists,
	writeJsonFile as writeJson,
} from "../utils/json";
import {
	generatedNamePattern,
	inferFilterNamingConventions,
	isGeneratedFilterName,
	type FilterNamingConvention,
} from "../workspace/filter-naming";
import { folderDisplayName, resolveFolder } from "../workspace/folders";
import {
	readFilterNamingConventions,
	readFilters,
	readFolders,
	workspacePaths,
} from "../workspace/store";

type GeneratedFilter = {
	id: string;
	name: string;
	domain: string;
	targetFolder: string;
};

type ManualFilter = {
	id: string;
	name: string;
	enabled: boolean;
	text: string;
	sieve: string;
};

type ConsolidationCandidate = {
	existingFilter: {
		id: string;
		name: string;
		targetFolder: string;
	};
	confidence: "high" | "medium";
	reason: string;
	generatedFilters: {
		id: string;
		name: string;
		domain: string;
	}[];
};

type ConsolidationPlan = {
	kind: "workspace-filter-consolidation";
	dryRun: boolean;
	mutated: boolean;
	dir: string;
	generatedFilters: number;
	manualFilters: number;
	candidates: number;
	consolidatableGeneratedFilters: number;
	unconsolidatedGeneratedFilterCount: number;
	planFingerprint: string;
	consolidationCandidates: ConsolidationCandidate[];
	unconsolidatedGeneratedFilters: {
		id: string;
		name: string;
		domain: string;
		targetFolder: string;
	}[];
	warning?: string;
	auditPath?: string;
};

export async function consolidateFilters(context: CliContext): Promise<void> {
	const paths = workspacePaths(workspaceDirForContext(context));
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	const minDomains = getNumberFlag(context.args.flags, "min-domains", 1);
	const onlyTarget = getStringFlag(context.args.flags, "target-folder");
	if (confirm) {
		const client = createProtonMailClient(context.config);
		try {
			const [folders, savedConventions] = await Promise.all([
				readFolders(paths),
				readFilterNamingConventions(paths).catch(() => []),
			]);
			const dryRun = await readJsonIfExists<{
				planFingerprint?: string;
				dryRun?: boolean;
			}>(join(paths.plansDir, "filter-consolidation.json"));
			if (!dryRun?.dryRun || !dryRun.planFingerprint) {
				throw new Error(
					"filters consolidate --confirm requires a successful filters consolidate dry-run plan",
				);
			}
			const liveFilters = await client.listFilters();
			const namingConventions =
				savedConventions.length > 0
					? savedConventions
					: inferFilterNamingConventions(liveFilters, folders);
			const plan = buildConsolidationPlan(
				paths.dir,
				folders,
				liveFilters,
				namingConventions,
				{ minDomains, onlyTarget, dryRun: false },
			);
			if (plan.planFingerprint !== dryRun.planFingerprint) {
				throw new Error(
					"filters consolidate --confirm refused because the consolidation plan changed after the last dry run; run filters consolidate again",
				);
			}
			const audit = await applyConsolidationPlan(plan, liveFilters, client);
			const summary = redactConsolidationPlan({
				...plan,
				mutated: true,
				auditPath: audit.auditPath,
			});
			await writeJson(
				join(paths.reportsDir, "filter-consolidation.json"),
				summary,
			);
			printJson(summary);
			return;
		} finally {
			await client.close?.();
		}
	}

	const [folders, rawFilters, namingConventions] = await Promise.all([
		readFolders(paths),
		readFilters(paths),
		readFilterNamingConventions(paths).catch(() => []),
	]);
	if (context.config.protonmail.liveBrowser) {
		const client = createProtonMailClient(context.config);
		try {
			const liveFilters = await client.listFilters();
			const conventions =
				namingConventions.length > 0
					? namingConventions
					: inferFilterNamingConventions(liveFilters, folders);
			const summary = redactConsolidationPlan(
				buildConsolidationPlan(paths.dir, folders, liveFilters, conventions, {
					minDomains,
					onlyTarget,
					dryRun: true,
				}),
			);
			await writeJson(
				join(paths.plansDir, "filter-consolidation.json"),
				summary,
			);
			printJson(summary);
			return;
		} finally {
			await client.close?.();
		}
	}
	const filters = normalizeFilters(rawFilters);
	const summary = buildConsolidationPlan(
		paths.dir,
		folders,
		filters,
		namingConventions,
		{ minDomains, onlyTarget, dryRun: true },
	);
	await writeJson(join(paths.plansDir, "filter-consolidation.json"), summary);
	printJson(summary);
}

function buildConsolidationPlan(
	dir: string,
	folders: ProtonFolder[],
	filters: ProtonFilter[],
	namingConventions: FilterNamingConvention[],
	options: { minDomains: number; onlyTarget?: string; dryRun: boolean },
): ConsolidationPlan {
	const generated = filters
		.map((filter) => parseGeneratedFilter(filter, namingConventions))
		.filter((filter): filter is GeneratedFilter => filter !== undefined);
	const manual = filters
		.filter(
			(filter) => parseGeneratedFilter(filter, namingConventions) === undefined,
		)
		.map((filter) => ({
			id: filter.id,
			name: filter.name,
			enabled: filter.enabled,
			text: [filter.name, ...filter.conditions, ...filter.actions].join("\n"),
			sieve: filter.conditions[0] ?? filter.actions[0] ?? "",
		}));

	const folderNames = folders.map(folderDisplayName);
	const candidates: ConsolidationCandidate[] = [];
	const usedGenerated = new Set<string>();
	const existingByTarget = new Map<
		string,
		{
			existing: ManualFilter;
			inferred: ReturnType<typeof inferTargetFolder>;
			score: number;
		}
	>();
	for (const existing of manual) {
		if (!existing.enabled) {
			continue;
		}
		const inferred = inferTargetFolder(existing, folders, folderNames);
		if (!inferred) {
			continue;
		}
		const convention = namingConventions.find(
			(item) => normalize(item.sourceFilterName) === normalize(existing.name),
		);
		if (convention?.scope === "specific") {
			continue;
		}
		if (
			options.onlyTarget &&
			normalize(inferred.targetFolder) !==
				normalize(
					folderDisplayName(
						resolveFolder(folders, options.onlyTarget, { purpose: "target" }),
					),
				)
		) {
			continue;
		}
		const key = normalize(inferred.targetFolder);
		const score = existingFilterScore(existing, inferred, namingConventions);
		const current = existingByTarget.get(key);
		if (
			!current ||
			score > current.score ||
			(score === current.score &&
				existing.name.localeCompare(current.existing.name) < 0)
		) {
			existingByTarget.set(key, { existing, inferred, score });
		}
	}

	for (const { existing, inferred } of existingByTarget.values()) {
		if (!inferred) {
			continue;
		}
		const matching = generated
			.filter(
				(filter) =>
					normalize(filter.targetFolder) === normalize(inferred.targetFolder),
			)
			.sort((left, right) => left.domain.localeCompare(right.domain));
		if (matching.length < options.minDomains) {
			continue;
		}
		for (const filter of matching) {
			usedGenerated.add(filter.id);
		}
		candidates.push({
			existingFilter: {
				id: existing.id,
				name: existing.name,
				targetFolder: inferred.targetFolder,
			},
			confidence: inferred.confidence,
			reason: inferred.reason,
			generatedFilters: matching.map((filter) => ({
				id: filter.id,
				name: filter.name,
				domain: filter.domain,
			})),
		});
	}

	const unconsolidatedGenerated = generated
		.filter((filter) => !usedGenerated.has(filter.id))
		.sort(
			(left, right) =>
				left.targetFolder.localeCompare(right.targetFolder) ||
				left.domain.localeCompare(right.domain),
		)
		.map((filter) => ({
			id: filter.id,
			name: filter.name,
			domain: filter.domain,
			targetFolder: filter.targetFolder,
		}));

	const summary = {
		kind: "workspace-filter-consolidation" as const,
		dryRun: options.dryRun,
		mutated: false,
		dir,
		generatedFilters: generated.length,
		manualFilters: manual.length,
		candidates: candidates.length,
		consolidatableGeneratedFilters: candidates.reduce(
			(sum, candidate) => sum + candidate.generatedFilters.length,
			0,
		),
		unconsolidatedGeneratedFilterCount: unconsolidatedGenerated.length,
		planFingerprint: consolidationFingerprint(candidates),
		consolidationCandidates: candidates.sort(
			(left, right) =>
				right.generatedFilters.length - left.generatedFilters.length ||
				left.existingFilter.targetFolder.localeCompare(
					right.existingFilter.targetFolder,
				) ||
				left.existingFilter.name.localeCompare(right.existingFilter.name),
		),
		unconsolidatedGeneratedFilters: unconsolidatedGenerated,
		warning: options.dryRun
			? "Dry run only. Review this plan before editing Proton filters; no filters were changed."
			: undefined,
	};
	return summary;
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

async function applyConsolidationPlan(
	plan: ConsolidationPlan,
	liveFilters: ProtonFilter[],
	client: ProtonMailClient,
): Promise<{ auditPath: string }> {
	const byId = new Map(liveFilters.map((filter) => [filter.id, filter]));
	const updated: {
		id: string;
		name: string;
		mergedDomains: string[];
		deletedFilterIds: string[];
	}[] = [];
	for (const candidate of plan.consolidationCandidates) {
		const existing = byId.get(candidate.existingFilter.id);
		if (!existing) {
			throw new Error(
				`Existing filter missing from live snapshot: ${candidate.existingFilter.name}`,
			);
		}
		const existingSieve = existing.conditions[0] ?? existing.actions[0] ?? "";
		if (!existingSieve.trim()) {
			throw new Error(
				`Existing filter has no editable Sieve body: ${candidate.existingFilter.name}`,
			);
		}
		const domains = candidate.generatedFilters.map((filter) => filter.domain);
		const mergedSieve = mergeSieve(
			existingSieve,
			candidate.existingFilter.targetFolder,
			domains,
		);
		await client.updateFilter({
			id: existing.id,
			name: existing.name,
			sieve: mergedSieve,
			enabled: existing.enabled,
		});
		for (const generated of candidate.generatedFilters) {
			await client.deleteFilter({ id: generated.id });
		}
		updated.push({
			id: existing.id,
			name: existing.name,
			mergedDomains: domains.map(redactDomain),
			deletedFilterIds: candidate.generatedFilters.map((filter) => filter.id),
		});
	}
	const auditPath = join(
		plan.dir,
		"audit",
		`filter-consolidation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	await writeJson(auditPath, {
		kind: "workspace-filter-consolidation-audit",
		createdAt: new Date().toISOString(),
		mutated: true,
		updated,
		planFingerprint: plan.planFingerprint,
	});
	return { auditPath };
}

function mergeSieve(
	existingSieve: string,
	targetFolder: string,
	domains: string[],
): string {
	const normalizedExisting = existingSieve.toLowerCase();
	const missingDomains = [
		...new Set(domains.map((domain) => domain.toLowerCase())),
	]
		.filter((domain) => !normalizedExisting.includes(domain))
		.sort();
	if (missingDomains.length === 0) {
		return existingSieve;
	}
	const block = [
		"",
		"# email-organizer consolidated domains",
		`if address :domain :is "From" ${sieveStringList(missingDomains)} {`,
		`  fileinto ${sieveString(targetFolder)};`,
		'  addflag "\\\\Seen";',
		"  stop;",
		"}",
	].join("\n");
	return `${ensureSieveRequirements(existingSieve).trimEnd()}${block}\n`;
}

function ensureSieveRequirements(sieve: string): string {
	const normalized = sieve.toLowerCase();
	if (normalized.includes("fileinto") && normalized.includes("imap4flags")) {
		return sieve;
	}
	return `require ["fileinto", "imap4flags"];\n${sieve}`;
}

function sieveStringList(values: string[]): string {
	if (values.length === 1) {
		return sieveString(values[0]);
	}
	return `[${values.map(sieveString).join(", ")}]`;
}

function sieveString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function existingFilterScore(
	existing: ManualFilter,
	inferred: NonNullable<ReturnType<typeof inferTargetFolder>>,
	namingConventions: FilterNamingConvention[],
): number {
	const convention = namingConventions.find(
		(item) => normalize(item.sourceFilterName) === normalize(existing.name),
	);
	const confidenceScore = inferred.confidence === "high" ? 100 : 50;
	const scopeScore =
		convention?.scope === "generic"
			? 25
			: convention?.scope === "specific"
				? -25
				: 0;
	const conciseScore = Math.max(0, 20 - existing.name.length / 4);
	return confidenceScore + scopeScore + conciseScore;
}

function consolidationFingerprint(
	candidates: ConsolidationCandidate[],
): string {
	const stable = candidates
		.map((candidate) => ({
			existingFilterId: candidate.existingFilter.id,
			existingFilterName: redactFilterDisplayName(
				candidate.existingFilter.name,
			),
			targetFolder: candidate.existingFilter.targetFolder,
			generated: candidate.generatedFilters
				.map((filter) => ({
					id: filter.id,
					name: redactFilterDisplayName(filter.name),
					domain: redactDomain(filter.domain),
				}))
				.sort((left, right) => left.id.localeCompare(right.id)),
		}))
		.sort((left, right) =>
			left.existingFilterId.localeCompare(right.existingFilterId),
		);
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function redactConsolidationPlan(plan: ConsolidationPlan): ConsolidationPlan {
	return {
		...plan,
		consolidationCandidates: plan.consolidationCandidates.map((candidate) => ({
			...candidate,
			existingFilter: {
				...candidate.existingFilter,
				name: redactFilterDisplayName(candidate.existingFilter.name),
			},
			generatedFilters: candidate.generatedFilters.map((filter) => ({
				...filter,
				name: redactFilterDisplayName(filter.name),
				domain: redactDomain(filter.domain),
			})),
		})),
		unconsolidatedGeneratedFilters: plan.unconsolidatedGeneratedFilters.map(
			(filter) => ({
				...filter,
				name: redactFilterDisplayName(filter.name),
				domain: redactDomain(filter.domain),
			}),
		),
	};
}

function redactFilterDisplayName(value: string): string {
	return redactText(value, 160);
}

function redactDomain(value: string): string {
	return redactText(value, 160);
}

function parseGeneratedFilter(
	filter: ProtonFilter,
	namingConventions: FilterNamingConvention[],
): GeneratedFilter | undefined {
	const legacyMatch = filter.name.match(/^Email Organizer: (.+) -> (.+)$/);
	if (legacyMatch) {
		return {
			id: filter.id,
			name: filter.name,
			domain: legacyMatch[1].trim(),
			targetFolder: legacyMatch[2].trim(),
		};
	}

	for (const { prefix, targetFolder } of namingConventions) {
		const prefixWithSeparator = `${prefix} - `;
		if (!filter.name.startsWith(prefixWithSeparator)) {
			continue;
		}
		const domain = filter.name.slice(prefixWithSeparator.length).trim();
		if (!domain || !domain.includes(".")) {
			continue;
		}
		return {
			id: filter.id,
			name: filter.name,
			domain,
			targetFolder,
		};
	}
	if (
		!isGeneratedFilterName(filter.name) ||
		!generatedNamePattern().test(filter.name)
	) {
		return undefined;
	}
	return undefined;
}

function inferTargetFolder(
	filter: ManualFilter,
	folders: ProtonFolder[],
	folderNames: string[],
):
	| { targetFolder: string; confidence: "high" | "medium"; reason: string }
	| undefined {
	const fileinto = filter.text.match(/\bfileinto\s+(?:"([^"]+)"|([^;\n]+))/i);
	const fileintoTarget = fileinto?.[1] ?? fileinto?.[2];
	if (fileintoTarget) {
		const folder = safeResolveFolder(folders, fileintoTarget);
		if (folder) {
			return {
				targetFolder: folderDisplayName(folder),
				confidence: "high",
				reason: "Existing filter action already files into this folder.",
			};
		}
	}

	const nameText = normalize(filter.name);
	for (const folderName of folderNames.sort(
		(left, right) => right.length - left.length,
	)) {
		if (nameText.includes(normalize(folderName))) {
			return {
				targetFolder: folderName,
				confidence: "medium",
				reason: "Existing filter name or body mentions this folder.",
			};
		}
	}

	const alias = targetAlias(nameText);
	if (!alias) {
		return undefined;
	}
	const folder = safeResolveFolder(folders, alias);
	if (!folder) {
		return undefined;
	}
	return {
		targetFolder: folderDisplayName(folder),
		confidence: "medium",
		reason: `Existing filter name matches the ${folderDisplayName(folder)} folder policy.`,
	};
}

function targetAlias(text: string): string | undefined {
	const aliases: [RegExp, string][] = [
		[/\bbank(?:ing)?\b/, "bank"],
		[/\bpurchases?\b|\breceipts?\b/, "receipt"],
		[/\bcredit\s*cards?\b/, "credit-card"],
		[/\binvest(?:ment|ments|ing)?\b/, "investments"],
		[/\binvoices?\b|\bbilling\b/, "invoice"],
		[/\bcalendar\b|\bevents?\b/, "calendar"],
		[/\bchurch\b/, "church"],
		[/\bpets?\b/, "pet"],
		[/\bspam\b/, "Spam"],
	];
	return aliases.find(([pattern]) => pattern.test(text))?.[1];
}

function safeResolveFolder(
	folders: ProtonFolder[],
	selector: string,
): ProtonFolder | undefined {
	try {
		return resolveFolder(folders, selector.trim(), { purpose: "target" });
	} catch {
		return undefined;
	}
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

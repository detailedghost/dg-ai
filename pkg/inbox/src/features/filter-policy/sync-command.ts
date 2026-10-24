import { join } from "node:path";
import { getBooleanFlag, getListFlag, getStringFlag } from "../../cli/args";
import { workspaceDirForContext, type CliContext } from "../../cli/context";
import { printJson } from "../../cli/output";
import { createProtonMailClient } from "../../protonmail/client";
import { writeJsonFile } from "../../utils/json";
import { applySyncPlan, type PolicyWriteClient } from "./apply";
import { formatSyncReview } from "./format";
import { fullSieveOrThrow } from "./parse";
import {
	buildSyncPlan,
	planHash,
	type LiveFilter,
	type LiveFolder,
	type SyncPlan,
} from "./plan";
import type { SafetyIssue } from "./safety";
import { safetyIssues } from "./safety";
import type { DeclaredFiltersFile } from "./schema";
import {
	declaredFiltersPath,
	observeLive,
	readDeclaredFiltersIfExists,
	toLiveFilters,
	toLiveFolders,
	writeDeclaredFilters,
} from "./store";

type ProtonSnapshotClient = Omit<PolicyWriteClient, "listFilters"> & {
	listFolders(): Promise<
		Array<{
			id: string;
			name: string;
			path?: string;
			type?: "folder" | "label" | "system";
		}>
	>;
	listFilters(): Promise<
		Array<{
			id: string;
			name: string;
			enabled: boolean;
			conditions?: string[];
			actions?: string[];
			sequence?: number;
		}>
	>;
	close?(): Promise<void>;
};

export async function syncDeclaredFilters(context: CliContext): Promise<void> {
	if (context.config.provider !== "protonmail") {
		throw new Error(
			"filters sync is the Proton write path. It reads the declared filters file and applies the reviewed plan.",
		);
	}
	const dir = workspaceDirForContext(context);
	const path =
		getStringFlag(context.args.flags, "declared-path") ||
		declaredFiltersPath(dir);
	const declared = await readDeclaredFiltersIfExists(path);
	if (!declared) {
		throw new Error(
			`Declared filters file not found at ${path}. Run filters import first.`,
		);
	}
	const client = createProtonMailClient(context.config) as ProtonSnapshotClient;
	try {
		const live = await readLive(client);
		const plan = buildSyncPlan({
			desiredFilters: declared.filters,
			desiredFolders: declared.folders,
			liveFilters: live.filters,
			liveFolders: live.folders,
			observedFilters: toLiveFilters(declared).observed,
			observedFolders: toLiveFolders(declared).observed,
			naming: declared.policy.naming,
			pull: getListFlag(context.args.flags, "pull") ?? [],
			revert: getListFlag(context.args.flags, "revert") ?? [],
			approveDelete: getListFlag(context.args.flags, "approve-delete") ?? [],
		});
		const issues = safetyIssues({
			actions: plan.actions,
			notices: plan.notices,
			policy: declared.policy.safety,
			keepFirst: declared.policy.keepFirst,
			desiredNames: declared.filters.map((filter) => filter.name),
		});
		const hash = planHash(plan);
		const review = formatSyncReview(plan, issues);
		const planPath = join(dir, "plans", "filter-sync-plan.json");
		await writeJsonFile(planPath, {
			kind: "proton-filter-sync-plan",
			planHash: hash,
			declaredPath: path,
			plan,
			safety: issues,
			review,
		});
		const applying = await shouldApply(context, hash);
		if (!applying) {
			printJson(publicSummary(plan, issues, hash, path, planPath, true));
			return;
		}
		if (issues.length > 0) {
			throw new Error(
				`filters sync refused to apply.\n${issues.map((issue) => issue.message).join("\n")}`,
			);
		}
		const foldersByPath = new Map(
			live.folders.map((folder) => [folder.path, folder.id]),
		);
		const updated = await applySyncPlan({
			plan,
			approvedDeletes: getListFlag(context.args.flags, "approve-delete") ?? [],
			client,
			clock: { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) },
			rng: Math.random,
			declared,
			foldersByPath,
		});
		const after = await readLive(client);
		observeLive(updated, after.filters, after.folders);
		await writeDeclaredFilters(path, updated);
		printJson(publicSummary(plan, issues, hash, path, planPath, false));
	} finally {
		await client.close?.();
	}
}

async function shouldApply(context: CliContext, hash: string): Promise<boolean> {
	const dryRun = getBooleanFlag(context.args.flags, "dry-run");
	const confirm = getBooleanFlag(context.args.flags, "confirm");
	const applyFlag = context.args.flags.apply;
	if (applyFlag === true) {
		throw new Error(
			"filters sync --apply requires the plan hash from the reviewed dry run",
		);
	}
	const applyHash = typeof applyFlag === "string" ? applyFlag : "";
	if (dryRun && (confirm || applyHash)) {
		throw new Error(
			"filters sync accepts either --dry-run or an apply confirmation, not both",
		);
	}
	if (confirm && applyHash) {
		throw new Error("filters sync accepts either --confirm or --apply, not both");
	}
	if (applyHash) {
		if (applyHash !== hash) {
			throw new Error(
				`filters sync --apply refused because the plan hash is ${hash}. Run filters sync --dry-run again and review that plan.`,
			);
		}
		return true;
	}
	if (!confirm) return false;
	if (!process.stdin.isTTY) {
		throw new Error(
			`filters sync --confirm needs a terminal. Re-run with --apply ${hash}`,
		);
	}
	process.stdout.write(`Apply plan ${hash}? Type apply to continue: `);
	const line = await new Promise<string>((resolve) => {
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", (chunk) => resolve(String(chunk)));
	});
	if (line.trim() !== "apply") {
		throw new Error("filters sync --confirm was not accepted");
	}
	return true;
}

async function readLive(client: ProtonSnapshotClient): Promise<{
	filters: LiveFilter[];
	folders: LiveFolder[];
}> {
	const [folders, filters] = await Promise.all([
		client.listFolders(),
		client.listFilters(),
	]);
	return {
		folders: folders.map((folder) => ({
			id: folder.id,
			name: folder.name,
			path: folder.path?.trim() || folder.name,
			type: folder.type ?? "folder",
		})),
		filters: filters.map((filter) => ({
			id: filter.id,
			name: filter.name,
			enabled: filter.enabled,
			sieve: fullSieveOrThrow(filter),
			...(filter.sequence !== undefined ? { sequence: filter.sequence } : {}),
		})),
	};
}

function publicSummary(
	plan: SyncPlan,
	issues: SafetyIssue[],
	hash: string,
	path: string,
	planPath: string,
	dryRun: boolean,
): unknown {
	return {
		kind: "proton-filter-sync",
		dryRun,
		mutated: !dryRun,
		planHash: hash,
		declaredPath: path,
		planPath,
		creates: plan.actions.filter((action) => action.op.startsWith("create-"))
			.length,
		updates: plan.actions.filter(
			(action) =>
				action.op === "update-filter" || action.op === "revert-filter",
		).length,
		renames: plan.actions.filter((action) => action.op === "rename-folder")
			.length,
		reorders: plan.actions.filter((action) => action.op === "reorder-filters")
			.length,
		deletes: plan.actions.filter((action) => action.op.startsWith("delete-"))
			.length,
		withheldDeletes: plan.notices.filter(
			(notice) => notice.op === "delete-withheld",
		).length,
		drift: plan.notices.filter((notice) => notice.op === "drift").length,
		renameProposals: plan.notices.filter(
			(notice) => notice.op === "rename-proposal",
		).length,
		safety: issues,
		review: formatSyncReview(plan, issues),
	};
}

export type { DeclaredFiltersFile };

import { existsSync } from "node:fs";
import {
	activeVersions,
	formatMegabytes,
	listDgPluginVersions,
	planPluginCachePrune,
	shellCommand,
	treeContained,
} from "@dg/common/node";
import { blockedText, LAYOUT_TABLE } from "@dg/common/node/layout";
import type { LayoutPlan } from "@dg/common/node/layout-work";
import {
	allowRuleCheck,
	bootstrapCommand,
	skillFilesCheck,
} from "../doctor/checks";
import { CLI_PATH, cliLauncher, writableDirectory } from "../doctor/probes";
import { type CheckResult, type DoctorCheck, type DoctorContext, fail, ok, warn } from "../doctor/types";

type PlanStep = LayoutPlan["steps"][number];

function stepLines(step: PlanStep): string[] {
	const { action, from, to } = step;
	switch (action.kind) {
		case "move":
		case "setAside":
			return [`${from} has not moved to ${to}; run dg-skills install`];
		case "block":
			return [
				action.reason === "no-hook"
					? `${from} has not moved to ${to}; run dg-skills install`
					: blockedText({ reason: action.reason, from, to, refused: process.platform === "win32" }),
			];
		case "retryPending":
			return step.records.map((record) =>
				existsSync(record.to) && treeContained(record.from, record.to)
					? `${record.from} is copied and waits for removal`
					: `${record.from} is copied but the copy is incomplete; dg keeps it`,
			);
		case "keepUsed":
			return [`${from} and ${to} both hold data; compare them, then remove the one you do not need`];
		case "skip":
		case "absent":
			return [];
	}
}

async function layoutCheck(ctx: DoctorContext): Promise<CheckResult> {
	const { planLayout, snapshot } = await import("@dg/common/node/layout-work");
	const plan = planLayout(LAYOUT_TABLE, snapshot(ctx.paths, {}), {});
	const lines = plan.steps.flatMap(stepLines);
	if (plan.steps.every(({ action }) => action.kind === "skip" || action.kind === "absent"))
		return ok("every dg file is in its per-OS folder");
	const windowsBlock =
		process.platform === "win32"
			? plan.steps.find(({ action }) => action.kind === "block" && action.reason === "live-writer")
			: undefined;
	const fix = windowsBlock
		? blockedText({ reason: "live-writer", from: windowsBlock.from, to: windowsBlock.to, refused: true })
		: "dg-skills install";
	return warn(lines.join("\n"), fix);
}

export const installChecks: DoctorCheck[] = [
	skillFilesCheck(["browser"]),
	{
		id: "cli-binary",
		run(ctx) {
			const dest = cliLauncher(ctx.paths.binDir);
			return existsSync(dest)
				? ok(`${CLI_PATH} is installed`)
				: warn(
						`${CLI_PATH} is not installed`,
						bootstrapCommand(ctx),
					);
		},
	},
	{
		id: "bin-dir",
		run(ctx) {
			const dir = ctx.paths.binDir;
			const result = writableDirectory(dir);
			return result.writable
				? ok(`install directory ${dir} is writable`)
				: fail(
						`install directory ${dir} cannot be used: ${result.reason}`,
						`chmod u+rwx ${shellCommand([result.at])}`,
					);
		},
	},
	{
		id: "plugin-cache",
		run(ctx) {
			const active = activeVersions(ctx.home);
			if (!active)
				return ok("plugin cache not checked: installed_plugins.json unreadable");
			const { remove } = planPluginCachePrune(
				listDgPluginVersions(ctx.home),
				active,
				Date.now(),
			);
			if (remove.length === 0) return ok("no stale dg plugin versions in the Claude plugin cache");
			const bytes = remove.reduce((sum, version) => sum + version.bytes, 0);
			return warn(
				`${remove.length} stale version(s), ${formatMegabytes(bytes)} reclaimable`,
				`${shellCommand([cliLauncher(ctx.paths.binDir)])} install`,
			);
		},
	},
	allowRuleCheck("install"),
	{ id: "layout", run: layoutCheck },
];

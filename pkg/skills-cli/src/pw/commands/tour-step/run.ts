import { renderTourOverlayStep, TOUR_OVERLAY_TOKENS_CSS } from "@dg/common";
import { stringFlag, UsageError } from "../../core/args";
import type { DaemonHandler, ParsedArgs } from "../../core/spec";

const DEFAULT_WAIT_MS = 1500;

function requiredNumberFlag(args: ParsedArgs, name: string): number {
	const raw = stringFlag(args, name);
	if (raw === undefined) throw new UsageError(`Missing required --${name}`);
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new UsageError(`Invalid --${name} '${raw}': expected a number`);
	return value;
}

function optionalNumberFlag(args: ParsedArgs, name: string, fallback: number): number {
	const raw = stringFlag(args, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value)) throw new UsageError(`Invalid --${name} '${raw}': expected a number`);
	return value;
}

function parsePhase(value: string | undefined): "setup" | "tutorial" {
	if (value === undefined) return "tutorial";
	if (value === "setup" || value === "tutorial") return value;
	throw new UsageError(`Invalid --phase '${value}': use setup or tutorial`);
}

/**
 * Renders one TourScript step's spotlight + callout card for a local recording, through
 * the exact function the extension calls same-realm — see pkg/common/src/tour-overlay.ts
 * for why that function must stay import-free. `evaluateHandle` (not `evaluate`) is
 * required here: the function's return value holds live DOM nodes, which only a handle
 * can carry back across the realm boundary without Playwright trying to JSON-serialize them.
 */
const tourStep: DaemonHandler = async (ctx, args) => {
	const body = args.positionals[0] as string;
	const target = stringFlag(args, "target");
	const page = ctx.page();
	if (target) {
		const timeout = optionalNumberFlag(args, "timeout", DEFAULT_WAIT_MS);
		await page
			.locator(target)
			.scrollIntoViewIfNeeded({ timeout })
			.catch(() => undefined);
	}
	const step = {
		scriptTitle: stringFlag(args, "script-title"),
		heading: stringFlag(args, "heading"),
		body,
		index: requiredNumberFlag(args, "index"),
		total: requiredNumberFlag(args, "total"),
		phase: parsePhase(stringFlag(args, "phase")),
		video: args.flags.video === true,
		hideBody: args.flags["hide-body"] === true,
		actionMissing: args.flags["action-missing"] === true,
		waitingForClick: args.flags["waiting-for-click"] === true,
	};
	const opts = { css: TOUR_OVERLAY_TOKENS_CSS, step, target: target ?? null };
	await page.evaluateHandle(renderTourOverlayStep, opts);
	return {
		result: `Rendered step ${step.index + 1} of ${step.total}${target ? ` spotlighting ${target}` : " (centered)"}.`,
		code: `await page.evaluateHandle(renderTourOverlayStep, ${JSON.stringify(opts)});`,
	};
};

export default tourStep;

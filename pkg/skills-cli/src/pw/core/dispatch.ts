import { stripVTControlCharacters } from "node:util";
import type { Page } from "playwright-core";
import { UsageError } from "./args";
import { installHint } from "./install-hint";
import {
	DEFAULT_DEPTH,
	type PageHeader,
	type Parts,
	pageHeader,
	render,
	snapshotLine,
	writeSnapshot,
} from "./response";
import type { CommandSpec, Ctx, DaemonHandler, HandlerResult, ParsedArgs } from "./spec";
import { resolveTarget } from "./targets";

export type DispatchState = { lastHeader?: string };

export type DispatchOptions = {
	raw: boolean;
	codegen: boolean;
	state: DispatchState;
	sessionDepth?: number;
	envDepth?: number;
};

export type Dispatched = { text: string; exitCode: number };

const ERROR_LINES = 12;
const ERROR_LINE_MAX = 300;

export function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const hint = installHint(message);
	if (hint) return hint;
	return stripVTControlCharacters(message)
		.split("\n")
		.slice(0, ERROR_LINES)
		.map((line) => (line.length > ERROR_LINE_MAX ? `${line.slice(0, ERROR_LINE_MAX)}...` : line))
		.join("\n")
		.trim();
}

function currentPage(ctx: Ctx): Page | undefined {
	try {
		return ctx.page();
	} catch {
		return undefined;
	}
}

async function headerOf(ctx: Ctx, page: Page): Promise<PageHeader> {
	return pageHeader(page, ctx.events.totals(page));
}

async function attachSnapshot(
	ctx: Ctx,
	page: Page,
	outcome: HandlerResult,
	parts: Parts,
	options: DispatchOptions,
): Promise<void> {
	if (!outcome.snapshot) return;
	const request = outcome.snapshot === true ? {} : outcome.snapshot;
	const scope = request.target ? await resolveTarget(page, request.target) : undefined;
	parts.snapshot = await writeSnapshot(page, ctx.outputDir, {
		depth: request.depth ?? options.sessionDepth ?? options.envDepth ?? DEFAULT_DEPTH,
		filename: request.filename,
		scope,
	});
	if (options.raw && outcome.snapshot !== true) parts.result = snapshotLine(parts.snapshot);
}

const MODAL_OPENED = Symbol("modal-opened");

async function runHandler(handler: DaemonHandler, ctx: Ctx, args: ParsedArgs): Promise<HandlerResult> {
	const work = handler(ctx, args);
	const page = currentPage(ctx);
	if (!page) return work;
	const watch = ctx.events.watchDialog(page);
	try {
		const winner = await Promise.race([work, watch.opened.then(() => MODAL_OPENED)]);
		if (typeof winner !== "symbol") return winner;
		work.catch(() => undefined);
		return {};
	} finally {
		watch.dispose();
	}
}

export async function dispatch(
	handler: DaemonHandler,
	spec: CommandSpec,
	args: ParsedArgs,
	ctx: Ctx,
	options: DispatchOptions,
): Promise<Dispatched> {
	let outcome: HandlerResult;
	try {
		outcome = await runHandler(handler, ctx, args);
	} catch (error) {
		if (error instanceof UsageError) throw error;
		outcome = { error: describeError(error) };
	}

	const parts: Parts = { code: outcome.code };
	if (outcome.error) parts.error = outcome.error;
	else if (outcome.result !== undefined) {
		parts.result = typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result, null, 2);
	}

	const page = currentPage(ctx);
	if (page) {
		if (ctx.events.hasDialog(page)) {
			parts.modal = ctx.events.modal(page);
			return { text: render(parts, options), exitCode: parts.error ? 1 : 0 };
		}
		if (!outcome.error && spec.changesPage) {
			await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
		}
		try {
			if (!outcome.error) await attachSnapshot(ctx, page, outcome, parts, options);
		} catch (error) {
			parts.error = describeError(error);
			parts.snapshot = undefined;
		}
		const header = await headerOf(ctx, page);
		const key = `${header.url}\n${header.title}`;
		if (parts.snapshot || parts.error || key !== options.state.lastHeader) parts.page = header;
		options.state.lastHeader = key;
		parts.events = ctx.events.drain(page);
		parts.notices = ctx.events.drainNotices(page);
		parts.modal = ctx.events.modal(page);
	}

	return { text: render(parts, options), exitCode: parts.error ? 1 : 0 };
}

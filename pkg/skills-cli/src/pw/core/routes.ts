import type { Route } from "playwright-core";
import { MULTIPLE_SEPARATOR, UsageError } from "./args";
import type { Ctx, RouteEntry } from "./spec";

export type RouteOptions = {
	pattern: string;
	status?: string;
	body?: string;
	contentType?: string;
	header?: string;
	removeHeader?: string;
};

export function parseStatus(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const status = Number(value);
	if (!/^\d{3}$/.test(value) || status < 100 || status > 599) {
		throw new UsageError(
			`Invalid --status '${value}': use an HTTP status code from 100 to 599`,
		);
	}
	return status;
}

export function parseHeaders(
	value: string | undefined,
): Record<string, string> | undefined {
	if (!value) return undefined;
	const headers: Record<string, string> = {};
	for (const line of value.split(MULTIPLE_SEPARATOR)) {
		const colon = line.indexOf(":");
		if (colon <= 0)
			throw new UsageError(`Invalid --header '${line}': use "Name: value"`);
		headers[line.slice(0, colon).trim().toLowerCase()] = line
			.slice(colon + 1)
			.trim();
	}
	return headers;
}

export function parseHeaderNames(
	value: string | undefined,
): string[] | undefined {
	if (!value) return undefined;
	return value
		.split(",")
		.map((name) => name.trim().toLowerCase())
		.filter(Boolean);
}

export function buildRoute(options: RouteOptions): RouteEntry {
	const status = parseStatus(options.status);
	const addHeaders = parseHeaders(options.header);
	const removeHeaders = parseHeaderNames(options.removeHeader);
	const { pattern, body, contentType } = options;
	const handler = async (route: Route): Promise<void> => {
		if (isFulfill({ status, body })) {
			await route.fulfill(
				fulfillOptions({ status, body, contentType, addHeaders }),
			);
			return;
		}
		const headers = { ...route.request().headers(), ...addHeaders };
		for (const name of removeHeaders ?? []) delete headers[name];
		await route.continue({ headers });
	};
	return {
		pattern,
		status,
		body,
		contentType,
		addHeaders,
		removeHeaders,
		handler,
	};
}

type FulfillParts = Pick<
	RouteEntry,
	"status" | "body" | "contentType" | "addHeaders"
>;

const isFulfill = (entry: Pick<RouteEntry, "status" | "body">): boolean =>
	entry.body !== undefined || entry.status !== undefined;

function fulfillOptions(entry: FulfillParts) {
	return {
		status: entry.status ?? 200,
		...(entry.contentType === undefined
			? {}
			: { contentType: entry.contentType }),
		...(entry.addHeaders === undefined ? {} : { headers: entry.addHeaders }),
		...(entry.body === undefined ? {} : { body: entry.body }),
	};
}

/** Playwright code equivalent to the entry's route handler. */
export function routeCode(entry: RouteEntry): string {
	const pattern = JSON.stringify(entry.pattern);
	if (isFulfill(entry)) {
		return `await page.context().route(${pattern}, (route) => route.fulfill(${JSON.stringify(fulfillOptions(entry))}));`;
	}
	const lines = [
		`await page.context().route(${pattern}, (route) => {`,
		`\tconst headers = { ...route.request().headers(), ...${JSON.stringify(entry.addHeaders ?? {})} };`,
		...(entry.removeHeaders ?? []).map(
			(name) => `\tdelete headers[${JSON.stringify(name)}];`,
		),
		"\treturn route.continue({ headers });",
		"});",
	];
	return lines.join("\n");
}

export async function addRoute(ctx: Ctx, entry: RouteEntry): Promise<void> {
	await ctx.context.route(entry.pattern, entry.handler);
	ctx.state.routes.push(entry);
}

export async function removeRoutes(
	ctx: Ctx,
	pattern?: string,
): Promise<number> {
	const matching = ctx.state.routes.filter(
		(entry) => pattern === undefined || entry.pattern === pattern,
	);
	for (const entry of matching)
		await ctx.context.unroute(entry.pattern, entry.handler);
	ctx.state.routes = ctx.state.routes.filter(
		(entry) => !matching.includes(entry),
	);
	return matching.length;
}

const BODY_PREVIEW = 50;

export function describeRoute(entry: RouteEntry, index: number): string {
	const details: string[] = [];
	if (entry.status !== undefined) details.push(`status=${entry.status}`);
	if (entry.body !== undefined) {
		details.push(
			`body=${entry.body.length > BODY_PREVIEW ? `${entry.body.slice(0, BODY_PREVIEW)}...` : entry.body}`,
		);
	}
	if (entry.contentType) details.push(`contentType=${entry.contentType}`);
	if (entry.addHeaders)
		details.push(`addHeaders=${JSON.stringify(entry.addHeaders)}`);
	if (entry.removeHeaders)
		details.push(`removeHeaders=${entry.removeHeaders.join(",")}`);
	return `${index + 1}. ${entry.pattern}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

import type { Request } from "playwright-core";
import { stringFlag, UsageError } from "../../core/args";
import type { DaemonHandler } from "../../core/spec";

const isFetch = (request: Request): boolean =>
	["fetch", "xhr"].includes(request.resourceType());

function isSuccessful(request: Request): boolean {
	if (request.failure()) return false;
	const response = request.existingResponse();
	return response !== null && response.status() < 400;
}

export function renderRequest(
	request: Request,
	withBody: boolean,
	withHeaders: boolean,
): string {
	const response = request.existingResponse();
	let text = `[${request.method().toUpperCase()}] ${request.url()}`;
	if (response) text += ` => [${response.status()}] ${response.statusText()}`;
	else if (request.failure())
		text += ` => [FAILED] ${request.failure()?.errorText ?? "Unknown error"}`;
	if (withHeaders) {
		const headers = Object.entries(request.headers()).map(
			([name, value]) => `    ${name}: ${value}`,
		);
		if (headers.length > 0)
			text += `\n  Request headers:\n${headers.join("\n")}`;
	}
	if (withBody) {
		const body = request.postData();
		if (body) text += `\n  Request body: ${body}`;
	}
	return text;
}

function parseFilter(value: string | undefined): RegExp | undefined {
	if (value === undefined) return undefined;
	try {
		return new RegExp(value);
	} catch {
		throw new UsageError(
			`Invalid --filter '${value}': use a regular expression`,
		);
	}
}

const network: DaemonHandler = async (ctx, args) => {
	const filter = parseFilter(stringFlag(args, "filter"));
	const page = ctx.page();
	const lines = ctx.events
		.requests(page)
		.filter(
			(request) =>
				args.flags["static"] === true ||
				isFetch(request) ||
				!isSuccessful(request),
		)
		.filter((request) => !filter || filter.test(request.url()))
		.map((request) =>
			renderRequest(
				request,
				args.flags["request-body"] === true,
				args.flags["request-headers"] === true,
			),
		);
	if (args.flags["clear"] === true) ctx.events.clearRequests(page);
	return {
		result: lines.length === 0 ? "No network requests" : lines.join("\n"),
		code: "await page.requests();",
	};
};

export default network;

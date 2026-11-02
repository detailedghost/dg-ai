import type { InboxBrowserRequest, InboxBrowserResponse } from "@dg/common";
import { ProtonOperationError } from "./page-errors";
import { executeProtonPage, protonRequestPace } from "./page-operations";
import type { ProtonSessionHeaders } from "./page-session";

export type ProtonPageCall = {
	request: InboxBrowserRequest;
	headers: ProtonSessionHeaders;
};

export type ProtonPageResult =
	| InboxBrowserResponse
	| { error: { code: string; status?: number } };

async function runProtonPage(call: ProtonPageCall): Promise<ProtonPageResult> {
	try {
		return await executeProtonPage(call.request, {
			origin: location.origin,
			headers: call.headers,
			fetch: (input, init) => fetch(input, init),
			pace: protonRequestPace,
		});
	} catch (error) {
		return error instanceof ProtonOperationError
			? { error: { code: error.code, status: error.status } }
			: { error: { code: "network" } };
	}
}

(globalThis as { __dgProtonRun?: typeof runProtonPage }).__dgProtonRun =
	runProtonPage;

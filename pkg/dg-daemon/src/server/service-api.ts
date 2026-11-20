import {
	CLI_GRANT_PREFIX_HEADER,
	CREDENTIAL_SEALED_PREFIX,
	credentialNameInPrefix,
	isReservedCredentialPrefix,
	validateCredentialGrantPrefix,
	validateCredentialName,
} from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import type { ParsedJob } from "../jobs/config";
import {
	type RefreshDeps,
	type RefreshResult,
	refreshCredential,
} from "../jobs/credential-refresh";
import { sanitize } from "../jobs/sanitize";
import type { CredentialStore } from "../store/credentials-store";
import {
	HARDENING_HEADERS,
	isJsonContentType,
	json,
	readJsonObject,
	refuse,
	STORAGE_FAILED,
} from "./capped-body";
import { hasCredentialGrant, NOT_ALLOWED, scopedRead } from "./credentials";
import type { Logger } from "./log";
import { isBrowserOrigin } from "./origin";

export type ServiceApiStore = Pick<
	CredentialStore,
	"listCredentials" | "getCredential" | "verifyCredentialGrant" | "setCredential"
>;

export type ServiceApiRefresh = Omit<RefreshDeps, "logger"> & {
	paths: Pick<DgPaths, "jobSourcesPath" | "jobStateRoot">;
	readJobs: () => ParsedJob[];
};

const KNOWN_BODY_KEYS = new Set([
	"type",
	"requestId",
	"protocolVersion",
	"name",
	"value",
	"meta",
	"prefix",
	"grant",
	"job",
]);
const MAX_BODY_BYTES = 64 * 1024;

function text(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: {
			...HARDENING_HEADERS,
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}

const OPERATION_KEYS = {
	get: ["operation", "name"],
	list: ["operation"],
	refresh: ["operation", "name", "job"],
} as const;

const isOperation = (value: string): value is keyof typeof OPERATION_KEYS =>
	Object.hasOwn(OPERATION_KEYS, value);

const logName = (value: string): string => sanitize(value).slice(0, 100);

function refreshAnswer(result: RefreshResult, name: string): Response {
	if (result.ok) return json({ ok: true, value: { name, updatedAt: result.updatedAt } }, 200);
	return json(
		{
			ok: false,
			error: result.error,
			...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }),
		},
		result.status,
	);
}

type Note = (result: string) => void;

const forLog = (value: unknown): string =>
	typeof value === "string" ? logName(value) : "?";

async function handleRefresh(
	body: Record<string, unknown>,
	header: string,
	store: ServiceApiStore,
	logger: Pick<Logger, "info" | "warn" | "error">,
	refresh: ServiceApiRefresh,
	note: Note,
): Promise<Response> {
	const { name, job } = body;
	const answer = (result: string, response: Response): Response => {
		note(result);
		return response;
	};
	if (typeof name !== "string") return answer("400", refuse('"name" must be a string', 400));
	if (typeof job !== "string") return answer("400", refuse('"job" must be a string', 400));
	try {
		const prefix = validateCredentialGrantPrefix(header);
		if (isReservedCredentialPrefix(prefix) || prefix === CREDENTIAL_SEALED_PREFIX)
			return answer("refused", refuse(NOT_ALLOWED, 403));
		if (
			!credentialNameInPrefix(name, prefix) ||
			credentialNameInPrefix(name, CREDENTIAL_SEALED_PREFIX)
		)
			return answer("refused", refuse(NOT_ALLOWED, 403));
		let canonical: string;
		try {
			canonical = validateCredentialName(name);
		} catch (err) {
			return answer("refused", refuse((err as Error).message, 400));
		}
		const entry = refresh.readJobs().find((candidate) => candidate.name === job);
		if (!entry?.ok || entry.grant?.toLowerCase() !== prefix)
			return answer("refused", refuse(NOT_ALLOWED, 403));
		const result = await refreshCredential({
			paths: refresh.paths,
			store,
			job: entry,
			name,
			deps: { ...refresh, logger },
		});
		return answer(result.ok ? "ok" : String(result.status), refreshAnswer(result, canonical));
	} catch (err) {
		logger.error(
			`service API refresh failed: ${err instanceof Error ? err.name : typeof err}`,
		);
		return answer("500", refuse(STORAGE_FAILED, 500));
	}
}

/** Serves get, list and refresh under the grant prefix for a service that holds a token. */
export async function handleServiceApiCredentials(
	req: Request,
	store: ServiceApiStore,
	logger: Pick<Logger, "info" | "warn" | "error">,
	refresh: ServiceApiRefresh,
): Promise<Response> {
	if (req.method !== "POST") return text("not found", 404);
	if (isBrowserOrigin(req.headers.get("origin")))
		return text("refused: the service API rejects a browser Origin", 400);
	try {
		if (!hasCredentialGrant(req, store)) return refuse(NOT_ALLOWED, 401);
		if (!isJsonContentType(req))
			return text("Content-Type must be application/json", 415);
		const body = await readJsonObject(req, MAX_BODY_BYTES);
		if (body === "too-large") return refuse("request body is too large", 413);
		if (!body) return refuse("request body must be a JSON object", 400);
		const { operation } = body;
		if (typeof operation !== "string")
			return refuse('"operation" must be a string', 400);
		if (!isOperation(operation)) return refuse(NOT_ALLOWED, 403);
		const allowed: readonly string[] = OPERATION_KEYS[operation];
		const stray = Object.keys(body).find((key) => !allowed.includes(key));
		const note: Note = (result) =>
			logger.info(
				`service API refresh: job=${forLog(body.job)} credential=${forLog(body.name)} result=${result}`,
			);
		if (stray !== undefined && operation === "refresh") note("400");
		if (stray !== undefined)
			return refuse(
				`request body key "${KNOWN_BODY_KEYS.has(stray) ? stray : "other"}" is not supported`,
				400,
			);
		const prefix = req.headers.get(CLI_GRANT_PREFIX_HEADER) as string;
		if (operation === "list")
			return json(scopedRead({ operation }, prefix, store), 200);
		if (operation === "refresh")
			return await handleRefresh(body, prefix, store, logger, refresh, note);
		const { name } = body;
		if (typeof name !== "string") return refuse('"name" must be a string', 400);
		if (!credentialNameInPrefix(name, prefix)) return refuse(NOT_ALLOWED, 403);
		try {
			validateCredentialName(name);
		} catch (err) {
			return refuse((err as Error).message, 400);
		}
		return json(scopedRead({ operation, name }, prefix, store), 200);
	} catch (err) {
		logger.error(
			`service API credential request failed: ${err instanceof Error ? err.name : typeof err}`,
		);
		return refuse(STORAGE_FAILED, 500);
	}
}

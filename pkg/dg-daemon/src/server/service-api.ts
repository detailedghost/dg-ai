import {
	CLI_GRANT_PREFIX_HEADER,
	credentialNameInPrefix,
	validateCredentialName,
} from "@dg/common";
import type { CredentialStore } from "../store/credentials-store";
import { readCappedBody } from "./capped-body";
import { hasCredentialGrant, NOT_ALLOWED, scopedRead } from "./credentials";
import { isBrowserOrigin } from "./origin";

export type ServiceApiStore = Pick<
	CredentialStore,
	"listCredentials" | "getCredential" | "verifyCredentialGrant"
>;

const HARDENING_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
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
]);
const MAX_BODY_BYTES = 64 * 1024;
const STORAGE_FAILED =
	"Credential storage failed; check daemon health and encryption key access.";

function text(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: {
			...HARDENING_HEADERS,
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...HARDENING_HEADERS, "Content-Type": "application/json" },
	});
}

const refuse = (error: string, status: number) =>
	json({ ok: false, error }, status);

function isJsonContentType(req: Request): boolean {
	const type = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	return type === "application/json";
}

async function readJsonObject(
	req: Request,
): Promise<Record<string, unknown> | "too-large" | undefined> {
	const bytes = await readCappedBody(req, MAX_BODY_BYTES);
	if (!bytes) return "too-large";
	try {
		const parsed: unknown = JSON.parse(bytes.toString("utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Serves get and list under the grant prefix for a service that holds a token. */
export async function handleServiceApiCredentials(
	req: Request,
	store: ServiceApiStore,
): Promise<Response> {
	if (req.method !== "POST") return text("not found", 404);
	if (isBrowserOrigin(req.headers.get("origin")))
		return text("refused: the service API rejects a browser Origin", 400);
	try {
		if (!hasCredentialGrant(req, store)) return refuse(NOT_ALLOWED, 401);
		if (!isJsonContentType(req))
			return text("Content-Type must be application/json", 415);
		const body = await readJsonObject(req);
		if (body === "too-large") return refuse("request body is too large", 413);
		if (!body) return refuse("request body must be a JSON object", 400);
		const { operation } = body;
		if (typeof operation !== "string")
			return refuse('"operation" must be a string', 400);
		if (operation !== "get" && operation !== "list")
			return refuse(NOT_ALLOWED, 403);
		const allowed = operation === "get" ? ["operation", "name"] : ["operation"];
		const stray = Object.keys(body).find((key) => !allowed.includes(key));
		if (stray !== undefined)
			return refuse(
				`request body key "${KNOWN_BODY_KEYS.has(stray) ? stray : "other"}" is not supported`,
				400,
			);
		const prefix = req.headers.get(CLI_GRANT_PREFIX_HEADER) as string;
		if (operation === "list")
			return json(scopedRead({ operation }, prefix, store), 200);
		const { name } = body;
		if (typeof name !== "string") return refuse('"name" must be a string', 400);
		if (!credentialNameInPrefix(name, prefix)) return refuse(NOT_ALLOWED, 403);
		try {
			validateCredentialName(name);
		} catch (err) {
			return refuse((err as Error).message, 400);
		}
		return json(scopedRead({ operation, name }, prefix, store), 200);
	} catch {
		return refuse(STORAGE_FAILED, 500);
	}
}

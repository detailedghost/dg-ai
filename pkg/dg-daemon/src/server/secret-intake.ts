import {
	CREDENTIAL_MAX_VALUE_BYTES,
	type CredentialMeta,
	noteSecret,
	SECRET_CODE_HEADER,
	validateCredentialValue,
} from "@dg/common";
import type { CredentialStore } from "../store/credentials-store";
import type { AttachLimiter } from "./attach-limiter";
import { readCappedBody } from "./capped-body";
import { isLocalPageOrigin } from "./origin";
import type { PageCodes } from "./page-codes";

export type SecretIntent = { name: string; meta: CredentialMeta };

const LIMIT_KEY = "secret-intake";
const MAX_BODY_BYTES = CREDENTIAL_MAX_VALUE_BYTES * 2;
const HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
};

function refuse(text: string, status: number): Response {
	return new Response(text, { status, headers: HEADERS });
}

/** Names the credential for a live code without spending it; the meta stays in the daemon. */
export function handleSecretName(
	req: Request,
	deps: { port: number },
	codes: PageCodes<SecretIntent>,
	limiter: AttachLimiter,
): Response {
	const origin = req.headers.get("origin");
	if (origin !== null && !isLocalPageOrigin(origin, deps.port)) {
		return refuse("refused", 400);
	}
	if (!limiter.allow(LIMIT_KEY)) return refuse("too many requests", 429);
	const intent = codes.peek(req.headers.get(SECRET_CODE_HEADER) ?? "");
	if (intent === undefined) return refuse("no such code", 404);
	return new Response(JSON.stringify({ name: intent.name }), {
		headers: { "Content-Type": "application/json", ...HEADERS },
	});
}

/** Stores the typed value under the intent's name and meta; the value is noted for redaction first. */
export async function handleSecretIntake(
	req: Request,
	deps: { port: number; credentials: Pick<CredentialStore, "setCredential"> },
	codes: PageCodes<SecretIntent>,
	limiter: AttachLimiter,
): Promise<Response> {
	if (!isLocalPageOrigin(req.headers.get("origin"), deps.port)) {
		return refuse("refused", 400);
	}
	if (!limiter.allow(LIMIT_KEY)) return refuse("too many requests", 429);
	const body = await readCappedBody(req, MAX_BODY_BYTES);
	if (body === undefined) return refuse("refused: body is too large", 413);
	let code: unknown;
	let value: unknown;
	try {
		({ code, value } = JSON.parse(body.toString("utf8")) as {
			code?: unknown;
			value?: unknown;
		});
	} catch {
		return refuse("invalid JSON body", 400);
	}
	if (typeof value === "string") noteSecret(value);
	if (typeof code !== "string" || code.length === 0) {
		return refuse("refused: body must carry a code", 400);
	}
	try {
		validateCredentialValue(value);
	} catch {
		return refuse("refused: the value is empty or too large", 400);
	}
	const intent = codes.peek(code);
	if (intent === undefined) return refuse("no such code", 404);
	try {
		deps.credentials.setCredential(intent.name, value as string, intent.meta);
	} catch {
		return refuse("credential storage failed", 500);
	}
	codes.redeem(code);
	return new Response(null, { status: 204, headers: HEADERS });
}

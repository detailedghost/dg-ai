import {
	CHAT_CODE_PATH,
	OWNER_TOKEN_HEADER,
	type SessionBootstrap,
} from "../index";
import { DgCliError } from "../errors";
import { resolveDgPaths } from "./dg-paths";
import { requireOwnerToken } from "./owner-token";
import { loopbackHostHeader } from "./pidfile";

/** Trade the owner token for a one-time page code, so no URL carries the session token. */
export async function mintPageCode({
	port,
	sessionId,
}: Pick<SessionBootstrap, "port" | "sessionId">): Promise<string> {
	const resp = await fetch(`http://127.0.0.1:${port}${CHAT_CODE_PATH}`, {
		method: "POST",
		headers: {
			...loopbackHostHeader(port),
			"Content-Type": "application/json",
			[OWNER_TOKEN_HEADER]: requireOwnerToken(resolveDgPaths()),
		},
		body: JSON.stringify({ sessionId }),
	});
	if (!resp.ok) {
		throw new DgCliError(
			`page code request failed: ${resp.status} ${await resp.text()}`,
		);
	}
	const { code } = (await resp.json()) as { code?: unknown };
	if (typeof code !== "string" || code.length === 0) {
		throw new DgCliError("dg-daemon did not issue a page code");
	}
	return code;
}

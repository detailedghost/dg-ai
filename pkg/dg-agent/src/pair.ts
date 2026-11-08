import {
	CHAT_PAIR_CLAIM_PATH,
	DgCliError,
	EXIT_GENERAL_FAILURE,
	OWNER_TOKEN_HEADER,
	noteSecret,
	PAIR_CODE_PATTERN,
	type PairClaimRequest,
} from "@dg/common";
import {
	loopbackHostHeader,
	requireOwnerToken,
	resolveCliSession,
	resolveDgPaths,
	writeStdout,
} from "@dg/common/node";

const USAGE = "pair takes a 6 digit code from the extension popup.";

export async function cmdPair({
	code,
	sessionId,
}: {
	code: string;
	sessionId?: string;
}): Promise<void> {
	if (!PAIR_CODE_PATTERN.test(code)) {
		throw new DgCliError(USAGE, EXIT_GENERAL_FAILURE);
	}
	noteSecret(code);
	const paths = resolveDgPaths();
	const session = await resolveCliSession(sessionId, paths);
	const owner = requireOwnerToken(paths);
	const response = await fetch(
		`http://127.0.0.1:${session.port}${CHAT_PAIR_CLAIM_PATH}`,
		{
			method: "POST",
			headers: {
				...loopbackHostHeader(session.port),
				"Content-Type": "application/json",
				[OWNER_TOKEN_HEADER]: owner,
			},
			body: JSON.stringify({
				code,
				sessionId: session.sessionId,
			} satisfies PairClaimRequest),
		},
	);
	if (!response.ok) {
		throw new DgCliError(await response.text(), EXIT_GENERAL_FAILURE);
	}
	await writeStdout(
		`Paired ${session.agentIdentity} (${session.sessionId.slice(0, 8)}) with the browser extension.\n`,
	);
}

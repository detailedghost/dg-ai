import type {
	CredentialRecord,
	CredentialsCliResult,
	CredentialSummary,
} from "@dg/common";

const CREDENTIALS_REQUEST_TIMEOUT_MS = 10_000;

/** Socket surface the request needs; the daemon chat socket after its connect handshake. */
export type CredentialsSocket = Pick<
	WebSocket,
	"send" | "addEventListener" | "removeEventListener"
>;

function request(
	socket: CredentialsSocket,
	fields: { operation: "get"; name: string } | { operation: "list" },
	timeoutMs: number,
): Promise<unknown> {
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener("message", onMessage);
		};
		const onMessage = (event: MessageEvent) => {
			let frame: CredentialsCliResult;
			try {
				frame = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (
				frame?.type !== "cli-credentials-result" ||
				frame.requestId !== requestId
			)
				return;
			cleanup();
			if (frame.ok) resolve(frame.value);
			else reject(new Error(frame.error || "Credential request failed."));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("dg-daemon did not answer the credential request."));
		}, timeoutMs);
		socket.addEventListener("message", onMessage);
		socket.send(
			JSON.stringify({ type: "cli-credentials-request", requestId, ...fields }),
		);
	});
}

/** Reads a credential under `extension/`; the daemon refuses any other name. */
export async function getExtensionCredential(
	socket: CredentialsSocket,
	name: string,
	timeoutMs = CREDENTIALS_REQUEST_TIMEOUT_MS,
): Promise<CredentialRecord | undefined> {
	return (
		((await request(
			socket,
			{ operation: "get", name },
			timeoutMs,
		)) as CredentialRecord | null) ?? undefined
	);
}

/** Lists credential names and metadata under `extension/`, never values. */
export async function listExtensionCredentials(
	socket: CredentialsSocket,
	timeoutMs = CREDENTIALS_REQUEST_TIMEOUT_MS,
): Promise<CredentialSummary[]> {
	return (await request(
		socket,
		{ operation: "list" },
		timeoutMs,
	)) as CredentialSummary[];
}

import {
	CHAT_CLI_PATH,
	CHAT_PROTOCOL_VERSION,
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
	type CliRequest,
	DgCliError,
	describeError,
} from "@dg/common";
import {
	readPidFile,
	readSessionToken,
	requireMatchingProtocol,
	resolveDgPaths,
	soleSessionForCwd,
} from "@dg/common/node";

const CLI_CONNECT_TIMEOUT_MS = 2_000;

export type ResolvedSession = {
	port: number;
	sessionId: string;
	token: string;
};

type BunWebSocketCtor = new (
	url: string,
	options?: Bun.WebSocketOptions,
) => WebSocket;
const BunWebSocket = WebSocket as unknown as BunWebSocketCtor;

export function resolveCliSession(explicitSessionId?: string): ResolvedSession {
	const paths = resolveDgPaths();
	const handle = readPidFile(paths);
	if (!handle) throw new DgCliError("no live dg-daemon pid file was found");
	requireMatchingProtocol(
		handle,
		'Run "dg-skills install" so both binaries come from the same release, ' +
			`then stop the daemon (pid ${handle.pid}) once nothing depends on it.`,
	);

	const sessionId =
		explicitSessionId ?? soleSessionForCwd(paths.sessionsDir).sessionId;

	return {
		port: handle.port,
		sessionId,
		token: readSessionToken(paths, sessionId),
	};
}

export class CliClient {
	private constructor(
		private readonly socket: WebSocket,
		readonly session: ResolvedSession,
	) {}

	static connect(
		session: ResolvedSession,
		timeoutMs = CLI_CONNECT_TIMEOUT_MS,
	): Promise<CliClient> {
		return new Promise((resolve, reject) => {
			let socket: WebSocket;
			try {
				socket = new BunWebSocket(
					`ws://127.0.0.1:${session.port}${CHAT_CLI_PATH}`,
					{
						headers: {
							[CLI_SESSION_ID_HEADER]: session.sessionId,
							[CLI_SESSION_TOKEN_HEADER]: session.token,
						},
					},
				);
			} catch (error) {
				reject(
					new DgCliError(
						`cannot connect to dg-daemon on port ${session.port}: ${describeError(error)}`,
					),
				);
				return;
			}

			const cleanup = () => {
				clearTimeout(timer);
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onError);
			};
			const onOpen = () => {
				cleanup();
				resolve(new CliClient(socket, session));
			};
			const onError = () => {
				cleanup();
				reject(
					new DgCliError(
						`cannot connect to dg-daemon on port ${session.port}; the daemon may be stopped or the session capability may be invalid`,
					),
				);
			};
			const timer = setTimeout(() => {
				cleanup();
				socket.close();
				reject(
					new DgCliError(
						`timed out connecting to dg-daemon on port ${session.port}`,
					),
				);
			}, timeoutMs);
			socket.addEventListener("open", onOpen, { once: true });
			socket.addEventListener("error", onError, { once: true });
		});
	}

	send(frame: CliRequest): void {
		this.socket.send(JSON.stringify(frame));
	}

	request<T>(
		frame: CliRequest,
		accept: (value: unknown) => value is T,
		timeoutMs: number,
	): Promise<T> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				this.socket.removeEventListener("message", onMessage);
				this.socket.removeEventListener("close", onClose);
				this.socket.removeEventListener("error", onError);
			};
			const onMessage = (event: MessageEvent) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(event.data as string);
				} catch {
					return;
				}
				if (!accept(parsed)) return;
				cleanup();
				resolve(parsed);
			};
			const onClose = () => {
				cleanup();
				reject(new DgCliError("dg-daemon closed the CLI connection"));
			};
			const onError = () => {
				cleanup();
				reject(new DgCliError("the dg-daemon CLI connection failed"));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new DgCliError("dg-daemon did not answer the CLI request"));
			}, timeoutMs);
			this.socket.addEventListener("message", onMessage);
			this.socket.addEventListener("close", onClose, { once: true });
			this.socket.addEventListener("error", onError, { once: true });
			this.send(frame);
		});
	}

	close(): void {
		this.socket.close();
	}
}

export function frameEnvelope(session: ResolvedSession) {
	return {
		sessionId: session.sessionId,
		token: session.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
	};
}

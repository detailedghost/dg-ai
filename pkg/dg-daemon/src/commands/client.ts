import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { CHAT_PROTOCOL_VERSION, type CliRequest } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { DgCliError } from "../server/errors";
import {
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
} from "../server/http";
import { readPidFile } from "../server/pidfile";
import { readSessionToken, type SessionTokenRecord } from "../session/tokens";
import { describeError } from "../utils/errors";

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

function readSessionFiles(sessionsDir: string): SessionTokenRecord[] {
	let names: string[];
	try {
		names = readdirSync(sessionsDir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		try {
			const value = JSON.parse(
				readFileSync(`${sessionsDir}/${name}`, "utf8"),
			) as Partial<SessionTokenRecord>;
			if (
				typeof value.sessionId === "string" &&
				typeof value.token === "string" &&
				typeof value.cwd === "string" &&
				typeof value.agentIdentity === "string"
			) {
				return [value as SessionTokenRecord];
			}
		} catch {
			return [];
		}
		return [];
	});
}

function formatCandidates(records: SessionTokenRecord[]): string {
	if (records.length === 0) return "  (none)";
	return records
		.map((record) => `  ${record.sessionId}  ${record.cwd}`)
		.join("\n");
}

export function resolveCliSession(explicitSessionId?: string): ResolvedSession {
	const paths = resolveDgPaths();
	const handle = readPidFile(paths);
	if (!handle) throw new DgCliError("no live dg-daemon pid file was found");

	let sessionId = explicitSessionId;
	if (!sessionId) {
		const records = readSessionFiles(paths.sessionsDir);
		const cwd = realpathSync(process.cwd());
		const matches = records.filter((record) => {
			try {
				return realpathSync(record.cwd) === cwd;
			} catch {
				return false;
			}
		});
		if (matches.length !== 1) {
			throw new DgCliError(
				`cannot resolve a session for cwd ${cwd}: found ${matches.length} matches; pass --session <id>. Live sessions:\n${formatCandidates(records)}`,
			);
		}
		sessionId = matches[0].sessionId;
	}

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
				socket = new BunWebSocket(`ws://127.0.0.1:${session.port}/cli`, {
					headers: {
						[CLI_SESSION_ID_HEADER]: session.sessionId,
						[CLI_SESSION_TOKEN_HEADER]: session.token,
					},
				});
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

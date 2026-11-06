import {
	type AnyRelayFeature,
	authorizeFrame,
	CHAT_PROTOCOL_VERSION,
	describeError,
	isRecord,
	type RelayCheck,
	type RelayCliResult,
	type RelayCtx,
	validateChatFrame,
} from "@dg/common";
import { readPidFile } from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import {
	type ConnectionManager,
	isExtensionPeer,
	onSocketClose,
	sendViaQueue,
	type SocketState,
} from "./connection";
import type { FrameHandlerDeps } from "./frame-handlers";

type Socket = ServerWebSocket<SocketState>;

type CliOf<F extends AnyRelayFeature> = ReturnType<F["validateCliRequest"]>;
type ResultFrameOf<F extends AnyRelayFeature> = Parameters<
	F["toCliResult"]
>[0] & { sessionId: string };

export type RelayOutcome =
	| { kind: "ok" | "error"; result: RelayCliResult }
	| { kind: "timeout" | "canceled" | "closed" }
	| { kind: "disconnected"; peer: "requester" | "extension" };

export type RelayHooks<F extends AnyRelayFeature = AnyRelayFeature> = {
	prepare?(ctx: {
		sessionId: string;
		requestId: string;
		requester: Socket;
		cli: CliOf<F>;
	}): CliOf<F> | { error: string };
	settled?(ctx: SettledCtx<F>): void;
	salvage?(ctx: { raw: Record<string, unknown>; socket: Socket }): ResultFrameOf<F>;
};

type SettledCtx<F extends AnyRelayFeature = AnyRelayFeature> = {
	outcome: RelayOutcome;
	cli: CliOf<F>;
	sessionId: string;
	requestId: string;
	requester: Socket;
};

type CliResultInput = {
	requester: Socket;
	sessionId: string;
	requestId: string;
	result: RelayCliResult;
};

export type BrowserRelay<F extends AnyRelayFeature = AnyRelayFeature> = {
	readonly feature: AnyRelayFeature;
	handleRequest(
		requester: Socket,
		sessionId: string,
		cli: CliOf<F>,
	): Promise<void>;
	handleCancel(
		requester: Socket,
		sessionId: string,
		cancel: { requestId: string },
	): void;
	handleResult(socket: Socket, frame: ResultFrameOf<F>): void;
	handleProgress(
		socket: Socket,
		frame: { sessionId: string; requestId: string; status: string },
	): void;
	settleRejected(socket: Socket, raw: unknown, reason?: string): boolean;
	failAll(socket: Socket, error: string): void;
	refuse(input: Omit<CliResultInput, "result"> & { error: string }): Promise<void>;
};

type Pending = {
	readonly sessionId: string;
	readonly requestId: string;
	readonly requester: Socket;
	readonly extension: Socket;
	lastStatus?: string;
	finish(outcome: RelayOutcome, result: RelayCliResult): void;
	finishSilently(outcome: RelayOutcome, result: RelayCliResult): void;
};

type RelayState = {
	pending: Map<string, Pending>;
	used: Map<string, Set<string>>;
};

type CheckInput = {
	requester: Socket;
	sessionId: string;
	requestId: string;
	ctx: RelayCtx;
};

type CheckOutcome =
	| { extension: Socket }
	| { refusal: string }
	| { duplicate: true };

type CapCounter = Extract<RelayCheck, { check: "cap" }>["of"][number];

const TIMEOUT_FALLBACK = "The relay request timed out.";

const states = new WeakMap<ConnectionManager, Map<string, RelayState>>();

const AT_CAP: Record<
	CapCounter,
	(input: {
		state: RelayState;
		caps: AnyRelayFeature["caps"];
		sessionId: string;
		requester: Socket;
	}) => boolean
> = {
	sessionIds: ({ state, caps, sessionId }) =>
		(state.used.get(sessionId)?.size ?? 0) >= caps.sessionIds,
	pending: ({ state, caps }) => state.pending.size >= caps.pending,
	requester: ({ state, caps, requester }) => {
		let mine = 0;
		for (const entry of state.pending.values())
			if (entry.requester === requester) mine++;
		return mine >= caps.perRequester;
	},
};

function key(sessionId: string, requestId: string): string {
	return JSON.stringify([sessionId, requestId]);
}

function failure(error: string): RelayCliResult {
	return { ok: false, error };
}

function errorClass(error: unknown): string {
	return error instanceof Error ? error.constructor.name : typeof error;
}

function logHookFailure(
	deps: FrameHandlerDeps,
	feature: AnyRelayFeature,
	hook: string,
	error: unknown,
): void {
	deps.logger.error(
		`relay ${feature.name} ${hook} hook threw ${errorClass(error)}`,
	);
}

function createState(
	deps: FrameHandlerDeps,
	feature: AnyRelayFeature,
): RelayState {
	const state: RelayState = { pending: new Map(), used: new Map() };
	deps.registry.on("closed", ({ sessionId }: { sessionId: string }) => {
		state.used.delete(sessionId);
		for (const pending of state.pending.values())
			if (pending.sessionId === sessionId)
				pending.finish({ kind: "closed" }, failure(feature.strings.sessionClosed));
	});
	return state;
}

function stateOf(deps: FrameHandlerDeps, feature: AnyRelayFeature): RelayState {
	let byFeature = states.get(deps.connections);
	if (!byFeature) {
		byFeature = new Map();
		states.set(deps.connections, byFeature);
	}
	let state = byFeature.get(feature.name);
	if (!state) {
		state = createState(deps, feature);
		byFeature.set(feature.name, state);
	}
	return state;
}

/** Builds the lifecycle owner for one feature table; relays for the same manager and feature share state. */
export function createBrowserRelay<F extends AnyRelayFeature>({
	deps,
	feature,
	hooks = {},
}: {
	deps: FrameHandlerDeps;
	feature: F;
	hooks?: RelayHooks<F>;
}): BrowserRelay<F> {
	const { frames, strings, caps } = feature;
	const state = stateOf(deps, feature);
	const relayHooks: RelayHooks = hooks;

	function sendCliResult({
		requester,
		sessionId,
		requestId,
		result,
	}: CliResultInput): Promise<void> {
		return sendViaQueue(
			requester,
			JSON.stringify({ type: frames.cliResult, sessionId, requestId, ...result }),
		);
	}

	function notifySettled(ctx: SettledCtx): void {
		try {
			relayHooks.settled?.(ctx);
		} catch (error) {
			logHookFailure(deps, feature, "settled", error);
		}
	}

	function timeoutText(ctx: RelayCtx): string {
		try {
			return strings.timeout(ctx);
		} catch (error) {
			logHookFailure(deps, feature, "timeout", error);
			return TIMEOUT_FALLBACK;
		}
	}

	function cancelInExtension(entry: Pending): void {
		if (frames.browserCancel === undefined) return;
		void sendViaQueue(
			entry.extension,
			JSON.stringify({
				type: frames.browserCancel,
				sessionId: entry.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: entry.requestId,
			}),
		).catch(() => {});
	}

	function ownedEntry(socket: Socket, sessionId: string, requestId: string) {
		const entry = state.pending.get(key(sessionId, requestId));
		return entry && entry.extension === socket && isExtensionPeer(socket)
			? entry
			: undefined;
	}

	function runChecks({
		requester,
		sessionId,
		requestId,
		ctx,
	}: CheckInput): CheckOutcome {
		const requestKey = key(sessionId, requestId);
		const peers: Socket[] = [];
		deps.connections.forEachCapableOf(sessionId, (socket) => {
			if (isExtensionPeer(socket)) peers.push(socket);
		});
		const extension = peers.length === 1 ? peers[0] : undefined;
		for (const check of feature.checks) {
			switch (check.check) {
				case "active":
					if (deps.registry.get(sessionId)?.state !== "active")
						return { refusal: check.refusal };
					break;
				case "pendingDuplicate": {
					const existing = state.pending.get(requestKey);
					if (!existing) break;
					if (existing.requester === requester) return { duplicate: true };
					if (check.refuseOtherRequester !== undefined)
						return { refusal: check.refuseOtherRequester };
					break;
				}
				case "replay":
					if (state.used.get(sessionId)?.has(requestId))
						return { refusal: check.refusal };
					break;
				case "cap":
					if (
						check.of.some((counter) =>
							AT_CAP[counter]({ state, caps, sessionId, requester }),
						)
					)
						return { refusal: check.refusal };
					break;
				case "peers":
					if (!extension)
						return {
							refusal: peers.length
								? check.multiple
								: check.none({ ...ctx, port: readPidFile(deps.paths)?.port }),
						};
					break;
				case "burn": {
					let ids = state.used.get(sessionId);
					if (!ids) {
						ids = new Set();
						state.used.set(sessionId, ids);
					}
					ids.add(requestId);
					break;
				}
				case "version":
					if (!check.accepts(extension?.data.extensionVersion))
						return { refusal: check.refusal };
					break;
				default: {
					const unreachable: never = check;
					return unreachable;
				}
			}
		}
		if (!extension) throw new Error(`relay ${feature.name} has no peers check`);
		return { extension };
	}

	function createPending({
		requester,
		extension,
		sessionId,
		requestId,
		cli,
		ctx,
	}: CheckInput & { extension: Socket; cli: SettledCtx["cli"] }): Pending {
		const requestKey = key(sessionId, requestId);
		let settled = false;
		let offRequester = () => {};
		let offExtension = () => {};
		const end = (
			outcome: RelayOutcome,
			result: RelayCliResult,
			deliver: boolean,
		) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			offRequester();
			offExtension();
			state.pending.delete(requestKey);
			notifySettled({ outcome, cli, sessionId, requestId, requester });
			if (deliver)
				void sendCliResult({ requester, sessionId, requestId, result }).catch(
					() => {},
				);
		};
		const entry: Pending = {
			sessionId,
			requestId,
			requester,
			extension,
			finish: (outcome, result) => end(outcome, result, true),
			finishSilently: (outcome, result) => end(outcome, result, false),
		};
		const timeout = setTimeout(() => {
			cancelInExtension(entry);
			entry.finish(
				{ kind: "timeout" },
				failure(timeoutText({ ...ctx, lastStatus: entry.lastStatus })),
			);
		}, ctx.timeoutMs);
		state.pending.set(requestKey, entry);
		offRequester = onSocketClose(requester, () => {
			if (settled) return;
			cancelInExtension(entry);
			entry.finishSilently(
				{ kind: "disconnected", peer: "requester" },
				failure(strings.requesterDisconnected),
			);
		});
		offExtension = onSocketClose(extension, () =>
			entry.finish(
				{ kind: "disconnected", peer: "extension" },
				failure(strings.extensionDisconnected),
			),
		);
		return entry;
	}

	const relay: BrowserRelay = {
		feature,
		async handleRequest(requester, sessionId, request) {
			const { requestId } = request;
			let cli = request;
			const refuse = (error: string): Promise<void> => {
				const result = failure(error);
				notifySettled({
					outcome: { kind: "error", result },
					cli,
					sessionId,
					requestId,
					requester,
				});
				return sendCliResult({ requester, sessionId, requestId, result });
			};
			if (relayHooks.prepare) {
				const prepared = relayHooks.prepare({
					sessionId,
					requestId,
					requester,
					cli,
				});
				if ("error" in prepared) return refuse(prepared.error);
				cli = prepared;
			}
			const timeoutMs = feature.timeoutMs(cli);
			const ctx: RelayCtx = { sessionId, cli, timeoutMs };
			const checked = runChecks({ requester, sessionId, requestId, ctx });
			if ("duplicate" in checked) return;
			if ("refusal" in checked) return refuse(checked.refusal);
			const { extension } = checked;
			const entry = createPending({
				requester,
				extension,
				sessionId,
				requestId,
				cli,
				ctx,
			});
			try {
				await sendViaQueue(
					extension,
					JSON.stringify({
						type: frames.browserRequest,
						sessionId,
						protocolVersion: CHAT_PROTOCOL_VERSION,
						requestId,
						...feature.toBrowserRequest(cli, timeoutMs),
					}),
				);
			} catch {
				const result = failure(strings.sendFailed);
				entry.finish({ kind: "error", result }, result);
			}
		},

		handleCancel(requester, sessionId, cancel) {
			if (strings.canceled === undefined) return;
			const entry = state.pending.get(key(sessionId, cancel.requestId));
			if (!entry || entry.requester !== requester) return;
			cancelInExtension(entry);
			entry.finishSilently({ kind: "canceled" }, failure(strings.canceled));
		},

		handleResult(socket, frame) {
			const entry = ownedEntry(socket, frame.sessionId, frame.requestId);
			if (!entry) return;
			const result = feature.toCliResult(frame);
			entry.finish({ kind: result.ok ? "ok" : "error", result }, result);
		},

		handleProgress(socket, frame) {
			const entry = ownedEntry(socket, frame.sessionId, frame.requestId);
			if (entry) entry.lastStatus = frame.status;
		},

		settleRejected(socket, raw, reason) {
			const { rejected } = strings;
			if (
				!rejected ||
				!isRecord(raw) ||
				raw.type !== frames.browserResult ||
				!isExtensionPeer(socket)
			)
				return false;
			const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
			const requestId = typeof raw.requestId === "string" ? raw.requestId : "";
			const entry = state.pending.get(key(sessionId, requestId));
			if (!entry || entry.extension !== socket) return false;
			const reject = (detail: string) => {
				const result = failure(rejected(detail));
				entry.finish({ kind: "error", result }, result);
			};
			if (relayHooks.salvage) {
				try {
					relay.handleResult(socket, relayHooks.salvage({ raw, socket }));
				} catch (error) {
					reject(describeError(error));
				}
				return true;
			}
			try {
				authorizeFrame(
					{ type: frames.browserResult, sessionId, token: raw.token },
					socket.data.capabilities,
				);
			} catch {
				return false;
			}
			let detail = reason;
			if (!detail) {
				try {
					validateChatFrame(raw);
					return false;
				} catch (error) {
					detail = describeError(error);
				}
			}
			reject(detail);
			return true;
		},

		failAll(socket, error) {
			for (const entry of state.pending.values()) {
				if (entry.extension !== socket) continue;
				const result = failure(error);
				entry.finish({ kind: "error", result }, result);
			}
		},

		refuse({ error, ...input }) {
			return sendCliResult({ ...input, result: failure(error) });
		},
	};
	return relay;
}

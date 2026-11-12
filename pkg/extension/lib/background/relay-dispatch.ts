import {
	type AnyRelayFeature,
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	type FeatureNamed,
	type RELAY_FEATURES,
	type RelayFeatureName,
	type RequestOf,
	type ResultBody,
	type SessionBootstrap,
} from "@dg/common";
import type { PwExtContext } from "./pw-ext";

const LIVENESS_MS = 250;

type Feature = (typeof RELAY_FEATURES)[number];

type RelayContexts = { "pw-ext": PwExtContext };

export type ContextOf<N extends RelayFeatureName> =
	N extends keyof RelayContexts ? RelayContexts[N] : undefined;

export type RelayHandler<F extends Feature> = (input: {
	request: RequestOf<F>;
	timeoutMs?: number;
	signal: AbortSignal;
	progress: (status: string) => void;
	context: ContextOf<F["name"]>;
}) => Promise<ResultBody<F>>;

export type RelayRun = {
	sessionId: string;
	requestId: string;
	feature: string;
	startedAt: number;
};

type RelayDispatcherOptions = {
	features: readonly AnyRelayFeature[];
	handlers: { [N in RelayFeatureName]: RelayHandler<FeatureNamed<N>> };
	send(frame: Record<string, unknown>): void;
	bootstrapFor(sessionId: string): SessionBootstrap | undefined;
	live(sessionId: string): (() => boolean) | undefined;
	contextFor: {
		[N in RelayFeatureName]?: (input: {
			bootstrap: SessionBootstrap;
		}) => ContextOf<N>;
	};
};

type ErasedHandler = (input: {
	request: unknown;
	timeoutMs?: number;
	signal: AbortSignal;
	progress: (status: string) => void;
	context: unknown;
}) => Promise<Record<string, unknown>>;

type Route = { feature: AnyRelayFeature; kind: "request" | "cancel" };

type RequestFrame = Extract<ChatFrame, { requestId: string }>;

type Run = RelayRun & { cancel: AbortController; live: () => boolean };

export function createRelayDispatcher({
	features,
	handlers,
	send,
	live,
	bootstrapFor,
	contextFor,
}: RelayDispatcherOptions) {
	const routes = new Map<string, Route>();
	for (const feature of features) {
		routes.set(feature.frames.browserRequest, { feature, kind: "request" });
		if (feature.frames.browserCancel)
			routes.set(feature.frames.browserCancel, { feature, kind: "cancel" });
	}
	const erasedHandlers = handlers as Record<string, ErasedHandler>;
	const contexts: Record<
		string,
		((input: { bootstrap: SessionBootstrap }) => unknown) | undefined
	> = contextFor;
	const runs = new Map<string, Run>();
	let watch: ReturnType<typeof setInterval> | undefined;

	function keyOf(sessionId: string, requestId: string): string {
		return JSON.stringify([sessionId, requestId]);
	}

	function admit(feature: AnyRelayFeature, frame: RequestFrame): void {
		const { sessionId, requestId } = frame;
		const timeoutMs = "timeoutMs" in frame ? frame.timeoutMs : undefined;
		const key = keyOf(sessionId, requestId);
		const bootstrap = bootstrapFor(sessionId);
		if (!bootstrap || runs.has(key)) return;
		const isLive = live(sessionId);
		if (!isLive) return;
		const cancel = new AbortController();
		runs.set(key, {
			sessionId,
			requestId,
			feature: feature.name,
			startedAt: Date.now(),
			cancel,
			live: isLive,
		});
		watch ??= setInterval(() => {
			for (const run of runs.values()) if (!run.live()) run.cancel.abort();
		}, LIVENESS_MS);
		const deadline = Number.isFinite(timeoutMs)
			? setTimeout(() => cancel.abort(), timeoutMs)
			: undefined;
		const emit = (body: Record<string, unknown>): void => {
			if (!isLive()) return;
			try {
				send({
					...body,
					sessionId,
					requestId,
					token: bootstrap.token,
					protocolVersion: CHAT_PROTOCOL_VERSION,
				});
			} catch {
				// A closed socket cannot carry its pending result.
			}
		};
		const { browserProgress, browserResult } = feature.frames;
		const progress = browserProgress
			? (status: string) => emit({ type: browserProgress, status })
			: () => undefined;
		(async () =>
			erasedHandlers[feature.name]({
				request: feature.fromBrowserRequest(frame),
				timeoutMs,
				signal: cancel.signal,
				progress,
				context: contexts[feature.name]?.({ bootstrap }),
			}))()
			.then(
				(body) => emit({ type: browserResult, ...body }),
				() =>
					emit({
						type: browserResult,
						ok: false,
						error: feature.strings.extensionFailed,
					}),
			)
			.finally(() => {
				clearTimeout(deadline);
				runs.delete(key);
				if (runs.size === 0 && watch !== undefined) {
					clearInterval(watch);
					watch = undefined;
				}
			});
	}

	return {
		dispatch(frame: ChatFrame): boolean {
			const route = routes.get(frame.type);
			if (!route) return false;
			if (!("requestId" in frame)) return true;
			if (route.kind === "request") admit(route.feature, frame);
			else if (bootstrapFor(frame.sessionId)) {
				runs.get(keyOf(frame.sessionId, frame.requestId))?.cancel.abort();
			}
			return true;
		},
		cancelSession(sessionId?: string): void {
			for (const run of runs.values())
				if (sessionId === undefined || run.sessionId === sessionId)
					run.cancel.abort();
		},
		pending(sessionId?: string): RelayRun[] {
			return [...runs.values()]
				.filter((run) => sessionId === undefined || run.sessionId === sessionId)
				.map(({ sessionId, requestId, feature, startedAt }) => ({
					sessionId,
					requestId,
					feature,
					startedAt,
				}));
		},
	};
}

import { type Mock, mock } from "bun:test";
import {
	CHAT_DEFAULT_PORT,
	CHAT_PROTOCOL_VERSION,
	type SessionBootstrap,
} from "@dg/common";
import { type RegisterDaemonLinkOptions, registerDaemonLink } from "@/lib/background/daemon-link";

export type Listener = (
	msg: unknown,
	sender: unknown,
	sendResponse: (r: unknown) => void,
) => boolean | undefined;

export type MockFn<Args extends unknown[], R = void> = ((
	...args: Args
) => R) & {
	mock: { calls: Args[] };
};

export type MockFnFactory = <Args extends unknown[], R>(
	impl: (...args: Args) => R,
) => MockFn<Args, R>;

export type FakeSocket = {
	send: MockFn<[string]>;
	addEventListener: MockFn<[string, (event?: unknown) => void]>;
	dispatch(type: string, event?: unknown): void;
};

export function makeFakeSocket(mockFn: MockFnFactory = mock): FakeSocket {
	const listeners: Record<string, Array<(event?: unknown) => void>> = {};
	return {
		send: mockFn((_data: string) => undefined),
		addEventListener: mockFn((type: string, cb: (event?: unknown) => void) => {
			if (!listeners[type]) listeners[type] = [];
			listeners[type].push(cb);
		}),
		dispatch(type: string, event?: unknown) {
			for (const cb of listeners[type] ?? []) cb(event);
		},
	};
}

export function frameEvent(frame: Record<string, unknown>) {
	return { data: JSON.stringify(frame) };
}

export const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

export { flushMicrotasks } from "./dom-events";

export function makeBootstrapFactory(
	defaults: SessionBootstrap,
): (overrides?: Partial<SessionBootstrap>) => SessionBootstrap {
	return (overrides = {}) => ({ ...defaults, ...overrides });
}

export const makeBootstrap = makeBootstrapFactory({
	port: 4317,
	sessionId: "sess-abc123",
	token: "tok-xyz789",
	agentIdentity: "claude-orchestrator",
});

export { captureGlobal } from "../../../pages/__tests__/utils/globals";

export type LocalArea = {
	data: Record<string, unknown>;
	get: Mock<(keys?: unknown) => Promise<Record<string, unknown>>>;
	set: Mock<(items: Record<string, unknown>) => Promise<void>>;
	remove: Mock<(keys: string | string[]) => Promise<void>>;
};

export function makeLocalArea(initial: Record<string, unknown> = {}): LocalArea {
	const data = { ...initial };
	return {
		data,
		get: mock(async (_keys?: unknown) => ({ ...data })),
		set: mock(async (items: Record<string, unknown>) => {
			Object.assign(data, items);
		}),
		remove: mock(async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
		}),
	};
}

export function makeStorage(local: LocalArea = makeLocalArea()) {
	return {
		local,
		session: {
			set: mock(() => Promise.resolve()),
			remove: mock((_key: string) => Promise.resolve()),
		},
	};
}

export type BootRelayOptions = {
	confirmSession?: boolean;
	sessionId?: string;
	token?: string;
	relayHandlers?: RegisterDaemonLinkOptions["relayHandlers"];
	local?: LocalArea;
};

export type BootedRelay = {
	socket: FakeSocket;
	posted: unknown[];
	postAs(senderUrl: string, message: unknown): Promise<unknown>;
	postAsOptionsPage(message: unknown): Promise<unknown>;
	extensionUrl(path: string): string;
	sessionId: string;
	token: string;
	sentFrames(): Record<string, unknown>[];
	local: LocalArea;
};

export async function bootRelay(
	options: BootRelayOptions = {},
): Promise<BootedRelay> {
	const sessionId = options.sessionId ?? "sess-abc123";
	const token = options.token ?? "tok-super-secret-xyz789";
	const socket = makeFakeSocket();
	let onMessage: Listener | undefined;
	const posted: unknown[] = [];
	const storage = makeStorage(options.local);
	const api = {
		action: { onClicked: { addListener: mock(() => undefined) } },
		runtime: {
			onMessage: {
				addListener: mock((cb: Listener) => {
					onMessage = cb;
				}),
			},
			getURL: mock((path: string) => `chrome-extension://test-ext/${path}`),
			sendMessage: mock((_m: unknown) => Promise.resolve(undefined)),
			openOptionsPage: mock(() => Promise.resolve()),
		},
		tabs: { create: mock(() => Promise.resolve()) },
		storage,
	};
	const link = registerDaemonLink({
		browserApi: api,
		openSocket: () => socket,
		relayHandlers: options.relayHandlers,
	});

	function postAs(senderUrl: string, message: unknown): Promise<unknown> {
		posted.push(message);
		return new Promise((resolve) => {
			const kept = onMessage?.(message, { url: senderUrl }, resolve);
			if (!kept) resolve(undefined);
		});
	}

	await link.adopt({
		port: CHAT_DEFAULT_PORT,
		sessionId,
		token,
		agentIdentity: "claude-orchestrator",
	});
	await settle();
	socket.dispatch("open");
	await settle();
	if (options.confirmSession !== false) {
		socket.dispatch(
			"message",
			frameEvent({
				type: "session-list",
				sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				sessions: [],
			}),
		);
		await settle();
	}

	return {
		socket,
		posted,
		postAs,
		postAsOptionsPage: (message) =>
			postAs(api.runtime.getURL("options.html"), message),
		extensionUrl: (path) => api.runtime.getURL(path),
		sessionId,
		token,
		local: storage.local,
		sentFrames: () =>
			socket.send.mock.calls.map(
				([raw]) => JSON.parse(raw as string) as Record<string, unknown>,
			),
	};
}

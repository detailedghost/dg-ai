import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHAT_DEFAULT_PORT, type SessionBootstrap } from "@dg/common";
import { Window } from "happy-dom";
import { MSG } from "@dg/pages/chat-messages";
import { frameEvent, makeFakeSocket, settle } from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerChat } = await import("@/lib/background/chat");
const { mountPairing } = await import("@/lib/features/pairing");

import { buildSessionListFrame } from "./utils/frame-fixtures";

type BackgroundListener = (
	message: unknown,
	sender: unknown,
	sendResponse: (response: unknown) => void,
) => boolean | undefined;

const windows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

function newRoot(): HTMLElement {
	const window = new Window();
	windows.add(window);
	const root = window.document.createElement("div");
	window.document.body.append(root);
	return root as unknown as HTMLElement;
}

function bootstrap(): SessionBootstrap {
	return {
		port: CHAT_DEFAULT_PORT,
		sessionId: "paired-session",
		token: "paired-token",
		agentIdentity: "extension",
	};
}

function backgroundHarness() {
	let listener: BackgroundListener | undefined;
	const sessionSet = mock(() => Promise.resolve());
	const sockets: ReturnType<typeof makeFakeSocket>[] = [];
	const subscribers = new Set<(message: unknown) => void>();
	const openSocket = mock(() => {
		const socket = makeFakeSocket();
		sockets.push(socket);
		return socket;
	});
	const api = {
		action: { onClicked: { addListener: mock(() => undefined) } },
		runtime: {
			onMessage: {
				addListener(next: BackgroundListener) {
					listener = next;
				},
			},
			getURL: (path: string) => `chrome-extension://pair-test/${path}`,
			getManifest: () => ({ version: "1.10.0" }),
			sendMessage: mock((message: unknown) => {
				for (const subscriber of subscribers) subscriber(message);
				return Promise.resolve();
			}),
		},
		tabs: {
			create: mock(() => Promise.resolve()),
			query: mock(() => Promise.resolve([])),
			update: mock(() => Promise.resolve()),
		},
		windows: { update: mock(() => Promise.resolve()) },
		storage: {
			session: {
				set: sessionSet,
				remove: mock(() => Promise.resolve()),
			},
		},
	};
	registerChat({ browserApi: api, openSocket });
	const runtime = {
		onMessage: {
			addListener: (listener: (message: unknown) => void) => { subscribers.add(listener); },
			removeListener: (listener: (message: unknown) => void) => { subscribers.delete(listener); },
		},
		sendMessage(message: unknown): Promise<unknown> {
			return new Promise((resolve) => {
				const keepChannel = listener?.(
					message,
					{ url: api.runtime.getURL("options.html") },
					resolve,
				);
				if (!keepChannel) resolve(undefined);
			});
		},
	};
	return { runtime, sessionSet, openSocket, sockets, api };
}

async function submit(root: HTMLElement, code: string): Promise<void> {
	const input = root.querySelector<HTMLInputElement>("input");
	if (!input) throw new Error("pairing input not found");
	const EventConstructor = root.ownerDocument.defaultView?.Event;
	if (!EventConstructor) throw new Error("event constructor not found");
	input.value = code;
	input.dispatchEvent(new EventConstructor("input", { bubbles: true }));
	root.querySelector<HTMLFormElement>("form")?.dispatchEvent(
		new EventConstructor("submit", { bubbles: true, cancelable: true }),
	);
	await settle();
}

function stubRuntime(
	reply: (message: Record<string, unknown>) => unknown,
) {
	return {
		onMessage: { addListener: mock(() => undefined) },
		sendMessage: mock((message: unknown) =>
			Promise.resolve(reply(message as Record<string, unknown>)),
		),
	};
}

function attachMessages(runtime: ReturnType<typeof stubRuntime>) {
	return runtime.sendMessage.mock.calls
		.map(([message]) => message as Record<string, unknown>)
		.filter((message) => message.type === MSG.sessionAttach);
}

function spyOnFetch() {
	const spy = mock(() => Promise.reject(new Error("fetch must not be called")));
	const original = globalThis.fetch;
	globalThis.fetch = spy as unknown as typeof fetch;
	return {
		spy,
		restore() {
			globalThis.fetch = original;
		},
	};
}

test("submitting a six digit code asks the background to attach every session and calls no fetch", async () => {
	const root = newRoot();
	const runtime = stubRuntime((message) =>
		message.type === MSG.connectionRequest ? { connected: false } : { ok: true },
	);
	const handle = mountPairing(root, {
		variant: "options",
		runtime,
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
	});
	await handle.ready;
	const network = spyOnFetch();
	try {
		await submit(root, "123456");
	} finally {
		network.restore();
	}

	expect(attachMessages(runtime)).toEqual([
		{ type: MSG.sessionAttach, all: true, code: "123456" },
	]);
	expect(network.spy).not.toHaveBeenCalled();
	expect(
		runtime.sendMessage.mock.calls.some(
			([message]) => (message as { type?: string }).type === MSG.markerCaptured,
		),
	).toBe(false);
	handle.destroy();
});

test("a failed attach shows the daemon's error text and re-enables the form", async () => {
	const root = newRoot();
	const runtime = stubRuntime((message) =>
		message.type === MSG.sessionAttach
			? {
					ok: false,
					error: "incorrect pairing code; 4 attempts left",
				}
			: { connected: false },
	);
	const handle = mountPairing(root, {
		variant: "options",
		runtime,
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
	});
	await handle.ready;

	await submit(root, "123456");

	expect(root.querySelector("[role='status']")?.textContent).toBe(
		"incorrect pairing code; 4 attempts left",
	);
	expect(root.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
	expect(
		root.querySelector<HTMLButtonElement>("button[type='submit']")?.disabled,
	).toBe(false);
	handle.destroy();
});

test("a successful attach refreshes the session list from the background", async () => {
	const root = newRoot();
	const attached = bootstrap();
	let attachedYet = false;
	const runtime = stubRuntime((message) => {
		if (message.type === MSG.sessionAttach) {
			attachedYet = true;
			return { ok: true };
		}
		if (message.type === MSG.connectionRequest) {
			return attachedYet
				? {
						connected: true,
						sessions: [
							{
								sessionId: attached.sessionId,
								agentIdentity: "claude",
								connected: true,
							},
						],
					}
				: { connected: false };
		}
		return undefined;
	});
	const handle = mountPairing(root, {
		variant: "options",
		runtime,
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
	});
	await handle.ready;
	expect(root.querySelectorAll(".pair-session")).toHaveLength(0);

	await submit(root, "123456");

	expect(root.querySelectorAll(".pair-session")).toHaveLength(1);
	expect(root.textContent).toContain("claude");
	expect(root.textContent).toContain("1 connected session");
	handle.destroy();
});

test("ignores a second submission while the attach is pending", async () => {
	const root = newRoot();
	let resolveAttach: ((reply: unknown) => void) | undefined;
	const runtime = {
		onMessage: { addListener: mock(() => undefined) },
		sendMessage: mock((message: unknown) =>
			(message as Record<string, unknown>).type === MSG.sessionAttach
				? new Promise((resolve) => {
						resolveAttach = resolve;
					})
				: Promise.resolve({ connected: false }),
		),
	};
	const handle = mountPairing(root, {
		variant: "options",
		runtime,
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
	});
	await handle.ready;

	await submit(root, "123456");
	await submit(root, "123456");

	expect(
		runtime.sendMessage.mock.calls.filter(
			([message]) => (message as { type?: string }).type === MSG.sessionAttach,
		),
	).toHaveLength(1);
	expect(root.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
	resolveAttach?.({ ok: true });
	await settle();
	handle.destroy();
});

test("an empty session list tells the user to start an agent and pair", async () => {
	const root = newRoot();
	const runtime = stubRuntime((message) =>
		message.type === MSG.connectionRequest
			? { connected: false, sessions: [] }
			: { sessions: [] },
	);
	const handle = mountPairing(root, {
		variant: "options",
		runtime,
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
	});
	await handle.ready;

	expect(root.querySelector("[role='status']")?.textContent).toBe(
		"No agent is connected. Start one with dg-agent start, then pair.",
	);
	handle.destroy();
});

test("the contextual Pair entry stays visible with confirmed connection status", async () => {
	const disconnectedRoot = newRoot();
	const disconnected = mountPairing(disconnectedRoot, {
		variant: "entry",
		runtime: {
			onMessage: { addListener: mock(() => undefined) },
			sendMessage: mock(() => Promise.resolve({ connected: false })),
		},
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
	});
	await disconnected.ready;
	expect(disconnectedRoot.hidden).toBe(false);
	expect(disconnectedRoot.textContent).toContain("Not paired");
	expect(disconnectedRoot.querySelector("button")?.textContent).toBe("Pair");

	const connectedRoot = newRoot();
	const connected = mountPairing(connectedRoot, {
		variant: "entry",
		runtime: {
			onMessage: { addListener: mock(() => undefined) },
			sendMessage: mock(() => Promise.resolve({ connected: true })),
		},
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
	});
	await connected.ready;
	expect(connectedRoot.hidden).toBe(false);
	expect(connectedRoot.textContent).toContain("connection confirmed");
});

test("the code input rejects values that are not exactly six digits", async () => {
	const root = newRoot();
	const runtime = stubRuntime(() => ({ connected: false }));
	const handle = mountPairing(root, {
		variant: "options",
		runtime,
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
	});
	await handle.ready;
	const input = root.querySelector<HTMLInputElement>("input");
	expect(input?.getAttribute("inputmode")).toBe("numeric");
	expect(input?.getAttribute("autocomplete")).toBe("one-time-code");

	await submit(root, "12ab");

	expect(attachMessages(runtime)).toHaveLength(0);
	expect(root.querySelector("[role='status']")?.textContent).toBe(
		"Enter a 6 digit code.",
	);
});

test("an unavailable daemon shows the start command", async () => {
	const root = newRoot();
	const handle = mountPairing(root, {
		variant: "entry",
		runtime: {
			onMessage: { addListener: mock(() => undefined) },
			sendMessage: mock(() => Promise.resolve({ connected: false })),
		},
		findPort: () => Promise.resolve(undefined),
	});
	await handle.ready;

	expect(root.textContent).toContain("Start the daemon: run dg-agent start");
	expect(root.querySelector<HTMLButtonElement>("button")?.hidden).toBe(true);
});

test("the options page includes its Pair section mount point", () => {
	const html = readFileSync(
		new URL("../entrypoints/options/index.html", import.meta.url),
		"utf8",
	);
	expect(html).toContain('id="pairPanel"');
});


test("disconnecting a previous session removes its credentials without interrupting the current session", async () => {
	const root = newRoot();
	const background = backgroundHarness();
	const older = bootstrap();
	const newer = { ...older, sessionId: "newer-session", token: "newer-token" };
	await background.runtime.sendMessage({ type: MSG.markerCaptured, bootstrap: older });
	await background.runtime.sendMessage({ type: MSG.markerCaptured, bootstrap: newer });
	const first = background.sockets[0]!;
	first.dispatch("open");
	first.dispatch("message", frameEvent(buildSessionListFrame([older, newer], { sessionId: older.sessionId })));
	first.dispatch("message", frameEvent(buildSessionListFrame([older, newer], { sessionId: newer.sessionId })));
	await settle();
	const handle = mountPairing(root, { variant: "options", runtime: background.runtime });
	await handle.ready;
	expect(root.textContent).toContain("2 connected sessions");
	expect(root.querySelector(".pair-session--current")?.textContent).toContain(newer.sessionId.slice(0, 8));
	expect(root.querySelector(".pair-session--current")?.textContent).toContain("Current");
	root.querySelector<HTMLButtonElement>(".pair-session button")?.click();
	await settle();
	first.dispatch("message", frameEvent({ type: "session-disconnected", sessionId: older.sessionId, protocolVersion: 1 }));
	await settle();
	expect(background.api.storage.session.remove).toHaveBeenCalledWith(`chat_session:${older.sessionId}`);
	expect(root.querySelectorAll(".pair-session")).toHaveLength(1);
	expect(background.sockets).toHaveLength(1);
	const frames = first.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
	expect(frames.some((frame) => frame.type === "session-disconnect" && frame.sessionId === older.sessionId)).toBe(true);
	expect(frames.some((frame) => frame.type === "session-close")).toBe(false);
	expect(root.textContent).toContain("1 connected session");
	first.dispatch("error");
	handle.destroy();
});

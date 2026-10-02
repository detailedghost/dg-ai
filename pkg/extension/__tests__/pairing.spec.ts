import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHAT_DEFAULT_PORT, type SessionBootstrap } from "@dg/common";
import { Window } from "happy-dom";
import { MSG } from "@/lib/chat-messages";
import { makeFakeSocket, settle } from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerChat } = await import("@/lib/background/chat");
const { mountPairing } = await import("@/lib/features/pairing");

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
	const socket = makeFakeSocket();
	const openSocket = mock(() => socket);
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
			sendMessage: mock(() => Promise.resolve()),
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
		onMessage: { addListener: mock(() => undefined) },
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
	return { runtime, sessionSet, openSocket };
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

test("a correct code sends the bootstrap through the marker path and connects the background", async () => {
	const root = newRoot();
	const background = backgroundHarness();
	const pairBootstrap = bootstrap();
	const fetchPair = mock(() =>
		Promise.resolve(
			new Response(JSON.stringify(pairBootstrap), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		),
	);
	const handle = mountPairing(root, {
		variant: "options",
		runtime: background.runtime,
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
		fetch: fetchPair,
	});
	await handle.ready;

	await submit(root, "123456");

	expect(fetchPair).toHaveBeenCalledWith(
		`http://127.0.0.1:${CHAT_DEFAULT_PORT}/pair`,
		expect.objectContaining({
			method: "POST",
			body: JSON.stringify({ code: "123456" }),
		}),
	);
	expect(background.sessionSet).toHaveBeenCalledTimes(1);
	expect(background.openSocket).toHaveBeenCalledWith(
		`ws://127.0.0.1:${CHAT_DEFAULT_PORT}/ws`,
	);
	expect(root.querySelector("[role='status']")?.textContent).toBe("Paired");
});

describe.each([
	[401, { attemptsLeft: 3 }, "Wrong code. 3 tries left."],
	[404, {}, "Code expired. Run dg-daemon pair again."],
	[410, {}, "Code expired. Run dg-daemon pair again."],
	[
		409,
		{},
		"Paired to another extension. Run dg-daemon origin clear, then try again.",
	],
] as const)("pairing error %i", (status, body, message) => {
	test(`shows ${message}`, async () => {
		const root = newRoot();
		const handle = mountPairing(root, {
			variant: "options",
			runtime: {
				onMessage: { addListener: mock(() => undefined) },
				sendMessage: mock(() => Promise.resolve({ connected: false })),
			},
			findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
			fetch: () =>
				Promise.resolve(
					new Response(JSON.stringify(body), {
						status,
						headers: { "content-type": "application/json" },
					}),
				),
		});
		await handle.ready;

		await submit(root, "123456");

		expect(root.querySelector("[role='status']")?.textContent).toBe(message);
	});
});

test("a text 401 response reports the daemon's remaining attempts", async () => {
	const root = newRoot();
	const handle = mountPairing(root, {
		variant: "options",
		runtime: {
			onMessage: { addListener: mock(() => undefined) },
			sendMessage: mock(() => Promise.resolve({ connected: false })),
		},
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
		fetch: () =>
			Promise.resolve(
				new Response("incorrect pairing code; 4 attempts left", {
					status: 401,
				}),
			),
	});
	await handle.ready;

	await submit(root, "123456");

	expect(root.querySelector("[role='status']")?.textContent).toBe(
		"Wrong code. 4 tries left.",
	);
});

test("the contextual Pair entry is visible only while not connected", async () => {
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
	expect(connectedRoot.hidden).toBe(true);
});

test("the code input rejects values that are not exactly six digits", async () => {
	const root = newRoot();
	const fetchPair = mock(() => Promise.resolve(new Response()));
	const handle = mountPairing(root, {
		variant: "options",
		runtime: {
			onMessage: { addListener: mock(() => undefined) },
			sendMessage: mock(() => Promise.resolve({ connected: false })),
		},
		findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
		fetch: fetchPair,
	});
	await handle.ready;
	const input = root.querySelector<HTMLInputElement>("input");
	expect(input?.getAttribute("inputmode")).toBe("numeric");
	expect(input?.getAttribute("autocomplete")).toBe("one-time-code");

	await submit(root, "12ab");

	expect(fetchPair).not.toHaveBeenCalled();
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

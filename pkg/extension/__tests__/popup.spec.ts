import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { CHAT_DEFAULT_PORT } from "@dg/common";
import { Window } from "happy-dom";
import { MSG } from "@dg/pages/chat-messages";

mock.module("wxt/browser", () => ({ browser: {} }));

const { mountPopup, renderAgentItems } = await import("@/lib/features/popup");
const { renderPairQr } = await import("@/lib/features/pair-qr");

type Row = Record<string, unknown>;

const NOW = 100_000;
const windows = new Set<Window>();
const globalsToRestore: Array<() => void> = [];

afterEach(async () => {
	jest.useRealTimers();
	for (const restore of globalsToRestore.splice(0).reverse()) restore();
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

function overrideGlobal(name: string, value: unknown): void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
	globalsToRestore.push(() => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	});
}

function newRoot(): HTMLElement {
	const window = new Window();
	windows.add(window);
	const root = window.document.createElement("div");
	window.document.body.append(root);
	return root as unknown as HTMLElement;
}

function flush(): Promise<void> {
	return (async () => {
		for (let i = 0; i < 40; i += 1) await Promise.resolve();
	})();
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function session(overrides: Row = {}): Row {
	return {
		sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
		agentIdentity: "claude-one",
		connected: true,
		presence: "cli",
		runs: [],
		...overrides,
	};
}

const run = (overrides: Row = {}): Row => ({
	sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
	requestId: "req-1",
	feature: "pw-ext",
	startedAt: NOW - 6_000,
	...overrides,
});

const pendingOffer = (code = "123456"): Row => ({
	status: "pending",
	code,
	expiresAt: NOW + 300_000,
});

type World = {
	connection: Row;
	offer: Row;
	replies: Record<string, unknown>;
	port: number | undefined;
};

function activeTab(id: number) {
	return Object.assign([{ id }], { id });
}

type BootOptions = { tabId?: number; noActiveTab?: boolean };

function boot(initial: Partial<World> = {}, options: BootOptions = {}) {
	const world: World = {
		connection: { connected: false, sessions: [] },
		offer: pendingOffer(),
		replies: {},
		port: CHAT_DEFAULT_PORT,
		...initial,
	};
	const listeners = new Set<(message: unknown) => void>();
	const runtime = {
		onMessage: {
			addListener: mock((listener: (message: unknown) => void) => {
				listeners.add(listener);
			}),
			removeListener: mock((listener: (message: unknown) => void) => {
				listeners.delete(listener);
			}),
		},
		openOptionsPage: mock(() => Promise.resolve()),
		sendMessage: mock((message: unknown) => {
			const type = (message as Row).type as string;
			if (type === MSG.connectionRequest) return Promise.resolve(world.connection);
			if (type === MSG.pairOfferRequest) return Promise.resolve(world.offer);
			return Promise.resolve(world.replies[type] ?? { ok: true });
		}),
	};
	const root = newRoot();
	const handle = mountPopup(root, {
		runtime,
		findPort: () => Promise.resolve(world.port),
		now: () => NOW,
		queryActiveTab: () =>
			Promise.resolve(options.noActiveTab ? [] : activeTab(options.tabId ?? 7)),
	} as never);
	return {
		world,
		root,
		runtime,
		handle,
		broadcast: (payload: Row) => {
			for (const listener of listeners) listener({ type: MSG.connection, ...payload });
		},
		sent: (type: string) =>
			runtime.sendMessage.mock.calls
				.map(([message]) => message as Row)
				.filter((message) => message.type === type),
	};
}

async function mounted(initial: Partial<World> = {}, options: BootOptions = {}) {
	const harness = boot(initial, options);
	await harness.handle.ready;
	await settle();
	return harness;
}

function paired(...sessions: Row[]): Partial<World> {
	return {
		connection: {
			connected: sessions.some((s) => s.connected === true),
			sessions,
		},
	};
}

function byText<T extends Element>(root: ParentNode, selector: string, text: string): T | undefined {
	return [...root.querySelectorAll(selector)].find(
		(node) => node.textContent?.trim() === text,
	) as T | undefined;
}

function cards(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(".ag")];
}

function cardOf(root: HTMLElement, identity: string): HTMLElement {
	const found = cards(root).find((card) => card.textContent?.includes(identity));
	if (!found) throw new Error(`no card for ${identity}`);
	return found;
}

function isHidden(node: Element | null | undefined): boolean {
	return !node || node.closest("[hidden]") !== null;
}

function qrPath(root: HTMLElement | Document, text: string): string {
	const doc = "createElementNS" in root ? root : root.ownerDocument;
	overrideGlobal("document", doc);
	return renderPairQr({ text }).querySelector("path")?.getAttribute("d") ?? "";
}

function key(root: HTMLElement, name: string, target?: Element): void {
	const View = root.ownerDocument.defaultView as unknown as {
		KeyboardEvent: typeof KeyboardEvent;
	};
	(target ?? root.ownerDocument.body).dispatchEvent(
		new View.KeyboardEvent("keydown", { key: name, bubbles: true }),
	);
}

function clickOutside(root: HTMLElement): void {
	const View = root.ownerDocument.defaultView as unknown as {
		MouseEvent: typeof MouseEvent;
	};
	for (const type of ["pointerdown", "mousedown", "click"]) {
		root.ownerDocument.body.dispatchEvent(
			new View.MouseEvent(type, { bubbles: true }),
		);
	}
}

function toggleOpen(root: HTMLElement, details: HTMLDetailsElement, open: boolean): void {
	details.open = open;
	const View = root.ownerDocument.defaultView as unknown as { Event: typeof Event };
	details.dispatchEvent(new View.Event("toggle"));
}

function foldOf(root: HTMLElement, summary: string): HTMLDetailsElement {
	const found = [...root.querySelectorAll<HTMLDetailsElement>("details")].find(
		(details) => details.querySelector("summary")?.textContent?.trim() === summary,
	);
	if (!found) throw new Error(`no details named ${summary}`);
	return found;
}

function stubClose(root: HTMLElement) {
	const close = mock(() => undefined);
	const view = root.ownerDocument.defaultView as unknown as { close: () => void };
	view.close = close;
	overrideGlobal("window", view);
	return close;
}

function supportVideo(on: boolean): void {
	overrideGlobal(
		"chrome",
		on ? { offscreen: {}, tabCapture: { getMediaStreamId: () => undefined } } : undefined,
	);
}

describe("mountPopup header and icon", () => {
	test.each([
		["unpaired", {}, "scan to pair"],
		["paired", paired(session()), "pairing"],
	])("the %s state shows the 44 px icon, the DeeGee title and the sub line", async (_name, world, sub) => {
		const { root, handle } = await mounted(world as Partial<World>);

		const icon = root.querySelector("img");
		expect(icon?.getAttribute("src")?.endsWith("/icon/48.png")).toBe(true);
		expect(icon?.getAttribute("width")).toBe("44");
		expect(icon?.getAttribute("height")).toBe("44");
		expect(icon?.getAttribute("alt")?.length).toBeGreaterThan(0);
		expect(root.querySelector(".neon-title")?.textContent).toContain("DeeGee");
		expect(root.querySelector(".sub")?.textContent?.trim()).toBe(sub);
		handle.destroy();
	});

	test("the unpaired daemon-down state does not tell the user to scan", async () => {
		const { root, handle } = await mounted({ offer: { status: "daemon-down" } });

		expect(root.querySelector(".sub")?.textContent?.trim()).toBe("daemon down");
		handle.destroy();
	});

	test.each([
		["expired", { offer: { status: "expired" } }],
		["daemon-down", { offer: { status: "daemon-down" } }],
		["error", { offer: { status: "error", error: "boom" } }],
		["claimed", { offer: { status: "claimed", agentIdentity: "agent-z" } }],
	])("the icon renders in the %s unpaired state", async (_name, world) => {
		const { root, handle } = await mounted(world as Partial<World>);

		expect(root.querySelector("img")?.getAttribute("src")?.endsWith("/icon/48.png")).toBe(true);
		expect(root.querySelector("img")?.getAttribute("alt")?.length).toBeGreaterThan(0);
		handle.destroy();
	});
});

describe("mountPopup unpaired", () => {
	test("shows the six digit code, its QR, the scan copy and an open paste fold", async () => {
		const { root, handle } = await mounted();

		expect(root.textContent).toContain("123456");
		const svg = root.querySelector('svg[aria-label="Pair QR code"]');
		expect(svg).not.toBeNull();
		expect(svg?.querySelector("path")?.getAttribute("d")).toBe(
			qrPath(root, "dg-agent pair 123456"),
		);
		expect(root.textContent).toContain(
			"Copy the pair command from the QR code, or run dg-agent pair 123456 in the agent's terminal.",
		);
		const fold = foldOf(root, "Paste a code instead");
		expect(fold.open).toBe(true);
		const input = fold.querySelector("input");
		expect(input?.getAttribute("inputmode")).toBe("numeric");
		expect(input?.getAttribute("maxlength")).toBe("6");
		expect(input?.getAttribute("pattern")).toBe("\\d{6}");
		expect(input?.getAttribute("placeholder")).toBe("123456");
		expect(input?.getAttribute("autocomplete")).toBe("off");
		handle.destroy();
	});

	test("requests the offer once on mount", async () => {
		const { sent, handle } = await mounted();

		expect(sent(MSG.pairOfferRequest)).toHaveLength(1);
		handle.destroy();
	});

	test("an expired offer shows a status note above the code area", async () => {
		const { root, handle } = await mounted({ offer: { status: "expired" } });

		const note = root.querySelector(".note[role='status']");
		expect(note?.textContent).toContain("Code expired.");
		handle.destroy();
	});

	test("a claimed offer shows a status note naming the agent", async () => {
		const { root, handle } = await mounted({
			offer: { status: "claimed", agentIdentity: "agent-z" },
		});

		expect(root.querySelector(".note[role='status']")?.textContent).toContain("Paired agent-z");
		handle.destroy();
	});

	test("a 429 error shows the daemon's text in a status note", async () => {
		const { root, handle } = await mounted({
			offer: { status: "error", error: "too many pairing offers; wait for one to expire" },
		});

		expect(root.querySelector(".note[role='status']")?.textContent).toContain(
			"too many pairing offers; wait for one to expire",
		);
		handle.destroy();
	});

	test("a daemon-down offer shows the start command and hides the paste fold", async () => {
		const { root, handle } = await mounted({ offer: { status: "daemon-down" } });

		expect(root.querySelector(".note[role='status']")?.textContent).toContain(
			"Start the daemon: run dg-agent start",
		);
		const fold = [...root.querySelectorAll("details")].find(
			(details) => details.querySelector("summary")?.textContent?.trim() === "Paste a code instead",
		);
		expect(isHidden(fold)).toBe(true);
		handle.destroy();
	});

	test("while the daemon is down the 2 s tick re-requests the offer and the code appears once it starts", async () => {
		jest.useFakeTimers();
		const harness = boot({ offer: { status: "daemon-down" } });
		await harness.handle.ready;
		await flush();
		expect(harness.root.textContent).not.toContain("123456");
		const before = harness.sent(MSG.pairOfferRequest).length;

		harness.world.offer = pendingOffer("123456");
		jest.advanceTimersByTime(2000);
		await flush();

		expect(harness.sent(MSG.pairOfferRequest).length).toBeGreaterThan(before);
		expect(harness.root.textContent).toContain("123456");
		harness.handle.destroy();
	});

	test("the tick keeps re-requesting a pending offer every 2 s", async () => {
		jest.useFakeTimers();
		const harness = boot();
		await harness.handle.ready;
		await flush();
		const before = harness.sent(MSG.pairOfferRequest).length;

		jest.advanceTimersByTime(2000);
		await flush();
		jest.advanceTimersByTime(2000);
		await flush();

		expect(harness.sent(MSG.pairOfferRequest).length - before).toBe(2);
		harness.handle.destroy();
	});

	test("a claimed agent switches the popup to the paired view and stops the offer requests", async () => {
		jest.useFakeTimers();
		const harness = boot();
		await harness.handle.ready;
		await flush();

		harness.world.connection = paired(session()).connection as Row;
		harness.broadcast(harness.world.connection);
		await flush();
		const before = harness.sent(MSG.pairOfferRequest).length;
		jest.advanceTimersByTime(6000);
		await flush();

		expect(harness.root.querySelector(".cnt")?.textContent).toContain("1 agent connected");
		expect(harness.root.querySelector('svg[aria-label="Pair QR code"]')).toBeNull();
		expect(harness.sent(MSG.pairOfferRequest)).toHaveLength(before);
		harness.handle.destroy();
	});
});

describe("mountPopup paired view", () => {
	const alpha = session({ sessionId: "aaaaaaaa-0000-0000-0000-000000000001", agentIdentity: "alpha" });
	const beta = session({
		sessionId: "bbbbbbbb-0000-0000-0000-000000000002",
		agentIdentity: "beta",
		connected: false,
		presence: undefined,
	});

	test("counts the agents with the right plural", async () => {
		const two = await mounted(paired(alpha, beta));
		expect(two.root.querySelector(".cnt")?.textContent?.trim()).toBe("2 agents connected to this browser");
		two.handle.destroy();

		const one = await mounted(paired(alpha));
		expect(one.root.querySelector(".cnt")?.textContent?.trim()).toBe("1 agent connected to this browser");
		one.handle.destroy();
	});

	test("renders one card per agent with identity, short session id and Unpair", async () => {
		const { root, handle } = await mounted(paired(alpha, beta));

		expect(cards(root)).toHaveLength(2);
		const card = cardOf(root, "alpha");
		expect(card.querySelector("b")?.textContent).toBe("alpha");
		expect(card.textContent).toContain("aaaaaaaa");
		expect(card.textContent).not.toContain("aaaaaaaa-0000");
		const unpair = card.querySelector('[aria-label="Unpair alpha"]');
		expect(unpair?.textContent?.trim()).toBe("Unpair");
		expect(unpair?.classList.contains("btn-danger")).toBe(true);
		expect(root.querySelectorAll('[aria-label^="Unpair "]')).toHaveLength(2);
		handle.destroy();
	});

	test.each([
		["connected with cli presence", { connected: true, presence: "cli", runs: [] }, "Connected", "on"],
		["connected, cli, with a run", { connected: true, presence: "cli", runs: [run()] }, "Working", "busy"],
		["disconnected with a run", { connected: false, presence: "cli", runs: [run()] }, "Working", "busy"],
		["connected but waiting", { connected: true, presence: "waiting", runs: [] }, "Idle", ""],
		["connected with no presence", { connected: true, presence: undefined, runs: [] }, "Idle", ""],
		["disconnected with cli presence", { connected: false, presence: "cli", runs: [] }, "Idle", ""],
		["connected but idle", { connected: true, presence: "idle", runs: [] }, "Idle", ""],
	])("pill for %s", async (_name, fields, label, variant) => {
		const { root, handle } = await mounted(paired(session(fields as Row)));

		const pill = root.querySelector(".ag .pill");
		expect(pill?.textContent?.trim()).toBe(label);
		expect(pill?.classList.contains("on")).toBe(variant === "on");
		expect(pill?.classList.contains("busy")).toBe(variant === "busy");
		handle.destroy();
	});

	test("shows run rows as feature label and elapsed seconds under the busy agent", async () => {
		const busy = session({
			agentIdentity: "busy-agent",
			runs: [
				run({ requestId: "r1", feature: "pw-ext", startedAt: NOW - 6_900 }),
				run({ requestId: "r2", feature: "proto", startedAt: NOW - 12_000 }),
				run({ requestId: "r3", feature: "inbox", startedAt: NOW - 1_000 }),
				run({ requestId: "r4", feature: "mystery-feature", startedAt: NOW - 3_000 }),
			],
		});
		const { root, handle } = await mounted(paired(busy));

		const rows = [...root.querySelectorAll("li.it.run")].map((row) => row.textContent?.trim());
		expect(rows).toEqual([
			"pw --ext · 6s",
			"Prototype · 12s",
			"Inbox · 1s",
			"mystery-feature · 3s",
		]);
		expect(root.querySelector("ul.tree")).not.toBeNull();
		handle.destroy();
	});

	test("clamps a future start time to 0 seconds", async () => {
		const { root, handle } = await mounted(
			paired(session({ runs: [run({ startedAt: NOW + 5_000 })] })),
		);

		expect(root.querySelector("li.it.run")?.textContent?.trim()).toBe("pw --ext · 0s");
		handle.destroy();
	});

	test("a card without rows gets nokids and no tree", async () => {
		const { root, handle } = await mounted(
			paired(session({ agentIdentity: "busy", runs: [run()] }), alpha),
		);

		expect(cardOf(root, "alpha").classList.contains("nokids")).toBe(true);
		expect(cardOf(root, "alpha").querySelector("ul.tree")).toBeNull();
		expect(cardOf(root, "busy").classList.contains("nokids")).toBe(false);
		handle.destroy();
	});

	test("ends with a closed Pair another agent fold and requests no offer on mount", async () => {
		const { root, handle, sent } = await mounted(paired(alpha));

		const fold = foldOf(root, "Pair another agent");
		expect(fold.open).toBe(false);
		expect(sent(MSG.pairOfferRequest)).toHaveLength(0);
		const folds = [...root.querySelectorAll("details")];
		expect(folds.at(-1)).toBe(fold);
		handle.destroy();
	});

	test("the first open of Pair another agent requests the offer and shows code, QR and a plain labeled paste field", async () => {
		const { root, handle, sent } = await mounted(paired(alpha));
		const fold = foldOf(root, "Pair another agent");

		toggleOpen(root, fold, true);
		await settle();

		expect(sent(MSG.pairOfferRequest)).toHaveLength(1);
		expect(fold.textContent).toContain("123456");
		expect(fold.querySelector('svg[aria-label="Pair QR code"]')).not.toBeNull();
		expect(fold.querySelectorAll("details")).toHaveLength(0);
		const input = fold.querySelector("input");
		expect(input).not.toBeNull();
		const id = input?.getAttribute("id");
		const labeled =
			(id && fold.querySelector(`label[for="${id}"]`)) || input?.closest("label");
		expect(labeled).toBeTruthy();
		handle.destroy();
	});

	test("while the fold is open the tick re-requests the offer, and closed it does not", async () => {
		jest.useFakeTimers();
		const harness = boot(paired(alpha));
		await harness.handle.ready;
		await flush();
		const fold = foldOf(harness.root, "Pair another agent");
		toggleOpen(harness.root, fold, true);
		await flush();
		const afterOpen = harness.sent(MSG.pairOfferRequest).length;

		jest.advanceTimersByTime(2000);
		await flush();
		const afterTick = harness.sent(MSG.pairOfferRequest).length;
		toggleOpen(harness.root, fold, false);
		await flush();
		jest.advanceTimersByTime(6000);
		await flush();

		expect(afterTick).toBe(afterOpen + 1);
		expect(harness.sent(MSG.pairOfferRequest)).toHaveLength(afterTick);
		harness.handle.destroy();
	});
});

describe("mountPopup reading the agent list", () => {
	test("re-reads on every connection broadcast", async () => {
		const harness = await mounted(paired(session({ agentIdentity: "alpha" })));
		const before = harness.sent(MSG.connectionRequest).length;

		harness.world.connection = paired(
			session({ agentIdentity: "alpha" }),
			session({ sessionId: "cccccccc-9", agentIdentity: "gamma" }),
		).connection as Row;
		harness.broadcast({});
		await settle();

		expect(harness.sent(MSG.connectionRequest).length).toBeGreaterThan(before);
		expect(harness.root.querySelector(".cnt")?.textContent).toContain("2 agents");
		harness.handle.destroy();
	});

	test("re-reads every 2 s while visible", async () => {
		jest.useFakeTimers();
		const harness = boot(paired(session()));
		await harness.handle.ready;
		await flush();
		const before = harness.sent(MSG.connectionRequest).length;

		jest.advanceTimersByTime(2000);
		await flush();
		jest.advanceTimersByTime(2000);
		await flush();

		expect(harness.sent(MSG.connectionRequest).length - before).toBe(2);
		harness.handle.destroy();
	});

	test("does not re-read while the document is hidden", async () => {
		jest.useFakeTimers();
		const harness = boot(paired(session()));
		await harness.handle.ready;
		await flush();
		const doc = harness.root.ownerDocument;
		Object.defineProperty(doc, "hidden", { configurable: true, value: true });
		overrideGlobal("document", doc);
		const before = harness.sent(MSG.connectionRequest).length;

		jest.advanceTimersByTime(6000);
		await flush();

		expect(harness.sent(MSG.connectionRequest)).toHaveLength(before);
		harness.handle.destroy();
	});

	test("a re-read keeps the card nodes, the pairing subtree, an open fold and an open menu", async () => {
		const alpha = session({ agentIdentity: "alpha" });
		const harness = await mounted(paired(alpha));
		const fold = foldOf(harness.root, "Pair another agent");
		toggleOpen(harness.root, fold, true);
		await settle();
		const svg = fold.querySelector('svg[aria-label="Pair QR code"]');
		const card = cardOf(harness.root, "alpha");
		const trigger = card.querySelector<HTMLButtonElement>('[aria-label="Menu for alpha"]');
		trigger?.click();
		await settle();
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");

		harness.world.connection = paired({ ...alpha, runs: [run()] }).connection as Row;
		harness.broadcast({});
		await settle();

		expect(cardOf(harness.root, "alpha")).toBe(card);
		expect(card.querySelector(".pill")?.textContent?.trim()).toBe("Working");
		expect(fold.open).toBe(true);
		expect(fold.querySelector('svg[aria-label="Pair QR code"]')).toBe(svg);
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		harness.handle.destroy();
	});

	test("destroy stops the timers and drops a late reply without rendering", async () => {
		jest.useFakeTimers();
		let release: ((reply: unknown) => void) | undefined;
		const root = newRoot();
		const runtime = {
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			openOptionsPage: () => Promise.resolve(),
			sendMessage: mock(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			),
		};
		const handle = mountPopup(root, {
			runtime,
			findPort: () => Promise.resolve(CHAT_DEFAULT_PORT),
			now: () => NOW,
			queryActiveTab: () => Promise.resolve(activeTab(1)),
		} as never);
		handle.destroy();
		const before = runtime.sendMessage.mock.calls.length;

		jest.advanceTimersByTime(10_000);
		release?.(paired(session({ agentIdentity: "ghost" })).connection);
		await flush();

		expect(runtime.sendMessage.mock.calls).toHaveLength(before);
		expect(root.textContent).not.toContain("ghost");
		expect(root.querySelectorAll(".ag")).toHaveLength(0);
	});
});

describe("mountPopup actions", () => {
	test("Unpair sends the disconnect message for that session and re-reads", async () => {
		const alpha = session({ sessionId: "aaaaaaaa-0000-0000-0000-000000000001", agentIdentity: "alpha" });
		const harness = await mounted(paired(alpha));
		const before = harness.sent(MSG.connectionRequest).length;

		harness.root.querySelector<HTMLButtonElement>('[aria-label="Unpair alpha"]')?.click();
		await settle();

		expect(harness.sent(MSG.sessionDisconnect)).toEqual([
			{ type: MSG.sessionDisconnect, sessionId: alpha.sessionId },
		]);
		expect(harness.sent(MSG.connectionRequest).length).toBeGreaterThan(before);
		harness.handle.destroy();
	});

	test("each card has its own menu with Open chat that sends the session id", async () => {
		const alpha = session({ sessionId: "aaaaaaaa-0000-0000-0000-000000000001", agentIdentity: "alpha" });
		const beta = session({ sessionId: "bbbbbbbb-0000-0000-0000-000000000002", agentIdentity: "beta" });
		const harness = await mounted(paired(alpha, beta));
		expect(harness.root.querySelectorAll('[aria-label^="Menu for "]')).toHaveLength(2);
		const trigger = harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu for beta"]');
		expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");

		trigger?.click();
		await settle();
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		const item = byText<HTMLButtonElement>(harness.root, "[role='menuitem']", "Open chat");
		expect(item?.tagName).toBe("BUTTON");
		item?.click();
		await settle();

		expect(harness.sent(MSG.openChat)).toEqual([
			{ type: MSG.openChat, sessionId: beta.sessionId },
		]);
		harness.handle.destroy();
	});

	test("a failed Open chat shows the reply error inside that card", async () => {
		const harness = await mounted({
			...paired(session({ agentIdentity: "alpha" })),
			replies: {
				[MSG.openChat]: { ok: false, error: "Daemon unreachable. Start it with dg-agent start, then retry." },
			},
		});

		harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu for alpha"]')?.click();
		await settle();
		byText<HTMLButtonElement>(harness.root, "[role='menuitem']", "Open chat")?.click();
		await settle();

		expect(cardOf(harness.root, "alpha").textContent).toContain(
			"Daemon unreachable. Start it with dg-agent start, then retry.",
		);
		harness.handle.destroy();
	});

	test("the header menu has Settings, which opens the options page", async () => {
		supportVideo(false);
		const harness = await mounted(paired(session()));
		const trigger = harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu"]');
		expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");

		trigger?.click();
		await settle();
		byText<HTMLButtonElement>(harness.root, "[role='menuitem']", "Settings")?.click();
		await settle();

		expect(harness.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
		harness.handle.destroy();
	});

	test("Record demo is absent when video recording is unsupported and present when supported", async () => {
		supportVideo(false);
		const off = await mounted(paired(session()));
		off.root.querySelector<HTMLButtonElement>('[aria-label="Menu"]')?.click();
		await settle();
		expect(byText(off.root, "[role='menuitem']", "Record demo")).toBeUndefined();
		expect(byText(off.root, "[role='menuitem']", "Settings")).toBeDefined();
		off.handle.destroy();

		supportVideo(true);
		const on = await mounted(paired(session()));
		on.root.querySelector<HTMLButtonElement>('[aria-label="Menu"]')?.click();
		await settle();
		expect(byText(on.root, "[role='menuitem']", "Record demo")).toBeDefined();
		on.handle.destroy();
	});

	async function recordDemoWith(
		reply: unknown,
		options: BootOptions = { tabId: 42 },
	) {
		supportVideo(true);
		const harness = await mounted(
			{ ...paired(session()), replies: { [MSG.recordDemo]: reply } },
			options,
		);
		const close = stubClose(harness.root);
		harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu"]')?.click();
		await settle();
		byText<HTMLButtonElement>(harness.root, "[role='menuitem']", "Record demo")?.click();
		await settle();
		return { harness, close };
	}

	test("Record demo sends the active tab id and closes the popup on started", async () => {
		const { harness, close } = await recordDemoWith({ outcome: "started" }, { tabId: 42 });

		expect(harness.sent(MSG.recordDemo)).toEqual([{ type: MSG.recordDemo, tabId: 42 }]);
		expect(close).toHaveBeenCalledTimes(1);
		harness.handle.destroy();
	});

	test.each([
		[{ outcome: "no-tour" }, "Open a page with a DeeGee video tour first."],
		[{ outcome: "refused", reason: "Approve this tour's automatic actions before recording." }, "Approve this tour's automatic actions before recording."],
		[{ outcome: "capture-failed", shortcut: "Alt+Shift+D" }, "Press Alt+Shift+D on the page to start recording."],
		[{ outcome: "capture-failed", shortcut: null }, "No keyboard shortcut is assigned to DeeGee. Assign one in your browser's extension shortcuts."],
	])("Record demo shows the text for %j and keeps the popup open", async (reply, text) => {
		const { harness, close } = await recordDemoWith(reply);

		expect(harness.root.textContent).toContain(text);
		expect(close).not.toHaveBeenCalled();
		harness.handle.destroy();
	});

	test("Record demo reports a missing active tab without asking the background or claiming there is no tour", async () => {
		const { harness, close } = await recordDemoWith(
			{ outcome: "started" },
			{ noActiveTab: true },
		);

		expect(harness.root.textContent).toContain("No active tab found. Open a page and try again.");
		expect(harness.root.textContent).not.toContain("video tour");
		expect(harness.sent(MSG.recordDemo)).toHaveLength(0);
		expect(close).not.toHaveBeenCalled();
		harness.handle.destroy();
	});

	test.each(["header", "card"])("Escape closes the %s menu and returns focus to its trigger", async (which) => {
		supportVideo(true);
		const harness = await mounted(paired(session({ agentIdentity: "alpha" })));
		const label = which === "header" ? "Menu" : "Menu for alpha";
		const trigger = harness.root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

		trigger?.click();
		await settle();
		const item = harness.root.querySelector<HTMLElement>("[role='menuitem']");
		item?.focus();
		key(harness.root, "Escape", item ?? undefined);
		await settle();

		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(harness.root.ownerDocument.activeElement).toBe(trigger);
		harness.handle.destroy();
	});

	test.each(["header", "card"])("an outside click closes the %s menu", async (which) => {
		const harness = await mounted(paired(session({ agentIdentity: "alpha" })));
		const label = which === "header" ? "Menu" : "Menu for alpha";
		const trigger = harness.root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

		trigger?.click();
		await settle();
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		clickOutside(harness.root);
		await settle();

		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		harness.handle.destroy();
	});

	test("opening one menu closes the other", async () => {
		const harness = await mounted(paired(session({ agentIdentity: "alpha" })));
		const header = harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu"]');
		const card = harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu for alpha"]');

		header?.click();
		await settle();
		card?.click();
		await settle();

		expect(card?.getAttribute("aria-expanded")).toBe("true");
		expect(header?.getAttribute("aria-expanded")).toBe("false");
		header?.click();
		await settle();
		expect(header?.getAttribute("aria-expanded")).toBe("true");
		expect(card?.getAttribute("aria-expanded")).toBe("false");
		harness.handle.destroy();
	});
});

describe("renderAgentItems", () => {
	test("renders a run row from the agent alone, using the ambient document and clock", () => {
		overrideGlobal("document", newRoot().ownerDocument);
		const agent = {
			...session(),
			runs: [run({ startedAt: Date.now() - 6_000 })],
		} as never;

		const rows = renderAgentItems(agent);

		expect(rows.map((row) => row.textContent)).toEqual(["pw --ext · 6s"]);
	});
});

describe("mountPopup daemon down while paired", () => {
	const down = session({ agentIdentity: "alpha", connected: false, presence: "cli" });

	test("shows one banner line with Retry above the cards, Idle pills and a working Unpair", async () => {
		const harness = await mounted({ ...paired(down), port: undefined });

		const text = harness.root.textContent ?? "";
		expect(text).toContain("Daemon not running. Run dg-agent start.");
		const retry = byText<HTMLElement>(harness.root, "a, button", "Retry");
		expect(retry).toBeDefined();
		const banner = [...harness.root.querySelectorAll("*")].find(
			(node) => node.children.length === 0 && node.textContent?.includes("Daemon not running"),
		);
		const firstCard = cards(harness.root)[0] as HTMLElement;
		expect(
			(banner as Node).compareDocumentPosition(firstCard) & 4,
		).toBeTruthy();
		expect(harness.root.querySelector(".ag .pill")?.textContent?.trim()).toBe("Idle");

		retry?.click();
		await settle();
		expect(harness.sent(MSG.connectionRetry)).toHaveLength(1);

		harness.root.querySelector<HTMLButtonElement>('[aria-label="Unpair alpha"]')?.click();
		await settle();
		expect(harness.sent(MSG.sessionDisconnect)).toHaveLength(1);
		harness.handle.destroy();
	});

	test("no banner when sessions are disconnected but the daemon answers", async () => {
		const harness = await mounted({ ...paired(down), port: CHAT_DEFAULT_PORT });

		expect(harness.root.textContent).not.toContain("Daemon not running");
		harness.handle.destroy();
	});

	test("no banner while any session is connected", async () => {
		const harness = await mounted({
			...paired(down, session({ agentIdentity: "beta" })),
			port: undefined,
		});

		expect(harness.root.textContent).not.toContain("Daemon not running");
		harness.handle.destroy();
	});

	test("Open chat with no port shows the reply error inline", async () => {
		const harness = await mounted({
			...paired(down),
			port: undefined,
			replies: { [MSG.openChat]: { ok: false, error: "Daemon unreachable. Start it with dg-agent start, then retry." } },
		});

		harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu for alpha"]')?.click();
		await settle();
		byText<HTMLButtonElement>(harness.root, "[role='menuitem']", "Open chat")?.click();
		await settle();

		expect(cardOf(harness.root, "alpha").textContent).toContain("Daemon unreachable");
		harness.handle.destroy();
	});
});

describe("mountPopup token hygiene", () => {
	test("never renders a token even when the reply carries one", async () => {
		const harness = await mounted(
			paired(session({ agentIdentity: "alpha", token: "super-secret-token" })),
		);

		expect(harness.root.innerHTML).not.toContain("super-secret-token");
		harness.handle.destroy();
	});
});

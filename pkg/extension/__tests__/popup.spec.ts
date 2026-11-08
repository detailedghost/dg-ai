import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CHAT_DEFAULT_PORT } from "@dg/common";
import { GROUP_COLORS } from "@/lib/config";
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
	agentTabs: Row;
	tabsFail: boolean;
	holdTabs?: Promise<void>;
	holdAdopt?: Promise<void>;
};

const PAGE_URL = "https://example.test/page";

function activeTab(id: number, extra: Row = {}) {
	return Object.assign([{ id, url: PAGE_URL, ...extra }], { id });
}

type BootOptions = { tabId?: number; noActiveTab?: boolean; tab?: Row };

function boot(initial: Partial<World> = {}, options: BootOptions = {}) {
	const world: World = {
		connection: { connected: false, sessions: [] },
		offer: pendingOffer(),
		replies: {},
		port: CHAT_DEFAULT_PORT,
		agentTabs: { groups: [] },
		tabsFail: false,
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
			if (type === MSG.agentTabsRequest)
				return (world.holdTabs ?? Promise.resolve()).then(() =>
					world.tabsFail ? Promise.reject(new Error("asleep")) : world.agentTabs,
				);
			if (type === MSG.agentTabAdopt && world.holdAdopt)
				return world.holdAdopt.then(() => world.replies[type] ?? { ok: true });
			return Promise.resolve(world.replies[type] ?? { ok: true });
		}),
	};
	const root = newRoot();
	const handle = mountPopup(root, {
		runtime,
		findPort: () => Promise.resolve(world.port),
		now: () => NOW,
		queryActiveTab: () =>
			Promise.resolve(
				options.noActiveTab
					? []
					: options.tab
						? [options.tab]
						: activeTab(options.tabId ?? 7),
			),
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

	test("a tick is skipped while the previous tick's reads are still in flight", async () => {
		jest.useFakeTimers();
		let release: () => void = () => undefined;
		const harness = boot({ offer: { status: "daemon-down" } });
		await harness.handle.ready;
		await flush();
		harness.world.holdTabs = new Promise<void>((resolve) => {
			release = resolve;
		});

		jest.advanceTimersByTime(2000);
		await flush();
		const connections = harness.sent(MSG.connectionRequest).length;
		const offers = harness.sent(MSG.pairOfferRequest).length;
		jest.advanceTimersByTime(4000);
		await flush();

		expect(harness.sent(MSG.connectionRequest)).toHaveLength(connections);
		expect(harness.sent(MSG.pairOfferRequest)).toHaveLength(offers);

		release();
		await flush();
		jest.advanceTimersByTime(2000);
		await flush();

		expect(harness.sent(MSG.connectionRequest).length).toBeGreaterThan(connections);
		expect(harness.sent(MSG.pairOfferRequest).length).toBeGreaterThan(offers);
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

const ALPHA_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const BETA_ID = "bbbbbbbb-0000-0000-0000-000000000002";

const tabRow = (tabId: number, overrides: Row = {}): Row => ({
	tabId,
	title: `Title ${tabId}`,
	url: `https://host-${tabId}.example.test/path`,
	selected: false,
	active: false,
	...overrides,
});

const groupOf = (sessionId: string, color: string, tabs: Row[]): Row => ({
	sessionId,
	color,
	tabs,
});

function withTabs(sessions: Row[], groups: Row[]): Partial<World> {
	return { ...paired(...sessions), agentTabs: { groups } };
}

function treeOf(root: HTMLElement, identity: string): HTMLElement | null {
	return cardOf(root, identity).parentElement?.querySelector("ul.tree") ?? null;
}

const tabItems = (tree: Element | null): HTMLElement[] =>
	[...(tree?.querySelectorAll<HTMLElement>("li.it:not(.run)") ?? [])];

function accessibleText(node: Element): string {
	return [
		node.textContent ?? "",
		node.getAttribute("aria-label") ?? "",
		...[...node.querySelectorAll("[aria-label]")].map(
			(child) => child.getAttribute("aria-label") ?? "",
		),
	].join(" ");
}

function menuItemOf(root: HTMLElement, label: string): HTMLButtonElement | undefined {
	return [...root.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].find((item) =>
		item.textContent?.includes(label),
	);
}

function reasonOf(item: Element | undefined): string {
	if (!item) return "";
	const described = item.getAttribute("aria-describedby");
	const target = described ? item.ownerDocument.getElementById(described)?.textContent : "";
	return [
		item.getAttribute("title"),
		item.getAttribute("aria-description"),
		item.getAttribute("aria-label"),
		item.textContent,
		target,
	].join(" ");
}

async function openAgentMenu(harness: Awaited<ReturnType<typeof mounted>>, identity: string) {
	harness.root
		.querySelector<HTMLButtonElement>(`[aria-label="Menu for ${identity}"]`)
		?.click();
	await settle();
}

const popupCss = readFileSync(
	new URL("../entrypoints/popup/style.css", import.meta.url),
	"utf8",
);

describe("mountPopup agent tabs", () => {
	const alpha = session({ sessionId: ALPHA_ID, agentIdentity: "alpha" });
	const beta = session({ sessionId: BETA_ID, agentIdentity: "beta" });

	test("lists each tab of a group as an li.it row with title and host, the selected one marked act", async () => {
		const harness = await mounted(
			withTabs(
				[alpha],
				[
					groupOf(ALPHA_ID, "blue", [
						tabRow(11, { title: "First page" }),
						tabRow(12, { selected: true, title: "Second page" }),
						tabRow(13, { active: true, title: "Third page" }),
					]),
				],
			),
		);

		const rows = tabItems(treeOf(harness.root, "alpha"));

		expect(rows).toHaveLength(3);
		expect(rows.map((row) => row.querySelector(".t")?.textContent)).toEqual([
			"First page",
			"Second page",
			"Third page",
		]);
		expect(rows.map((row) => row.querySelector(".mono")?.textContent)).toEqual([
			"host-11.example.test",
			"host-12.example.test",
			"host-13.example.test",
		]);
		expect(rows.map((row) => row.classList.contains("act"))).toEqual([false, true, false]);
		expect(rows[0]?.querySelector(".t")?.getAttribute("title")).toBe("First page");
		harness.handle.destroy();
	});

	test.each([
		["about:blank", "about:blank"],
		["a chrome:// page", "chrome://extensions/"],
		["no url", undefined],
	])("shows an empty host for %s", async (_name, url) => {
		const harness = await mounted(
			withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11, { url })])]),
		);

		const [row] = tabItems(treeOf(harness.root, "alpha"));

		expect(row?.querySelector(".t")?.textContent).toBe("Title 11");
		expect(row?.querySelector(".mono")?.textContent ?? "").toBe("");
		harness.handle.destroy();
	});

	test("renders tab rows first and then the run rows", async () => {
		const harness = await mounted(
			withTabs(
				[{ ...alpha, runs: [run({ sessionId: ALPHA_ID })] }],
				[groupOf(ALPHA_ID, "blue", [tabRow(11), tabRow(12, { selected: true })])],
			),
		);

		const rows = [...(treeOf(harness.root, "alpha")?.querySelectorAll("li.it") ?? [])];

		expect(rows.map((row) => row.classList.contains("run"))).toEqual([false, false, true]);
		harness.handle.destroy();
	});

	test("renders only the run row for an agent with one run and no tabs", async () => {
		const harness = await mounted(
			withTabs(
				[{ ...alpha, runs: [run({ sessionId: ALPHA_ID })] }],
				[groupOf(ALPHA_ID, "blue", [])],
			),
		);

		const tree = treeOf(harness.root, "alpha");

		expect(tabItems(tree)).toHaveLength(0);
		expect(tree?.querySelectorAll("li.it.run")).toHaveLength(1);
		expect(cardOf(harness.root, "alpha").classList.contains("nokids")).toBe(false);
		harness.handle.destroy();
	});

	test("marks an agent with no tabs and no runs as nokids and renders no tree", async () => {
		const harness = await mounted(withTabs([alpha], [groupOf(ALPHA_ID, "blue", [])]));

		expect(cardOf(harness.root, "alpha").classList.contains("nokids")).toBe(true);
		expect(treeOf(harness.root, "alpha")).toBeNull();
		harness.handle.destroy();
	});

	test("an agent with tabs is not nokids and its pill stays driven by runs only", async () => {
		const harness = await mounted(
			withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11, { selected: true })])]),
		);

		const card = cardOf(harness.root, "alpha");

		expect(card.classList.contains("nokids")).toBe(false);
		expect(card.querySelector(".pill")?.textContent?.trim()).toBe("Connected");
		harness.handle.destroy();
	});

	test("renders a hostile title as text and creates no element from it", async () => {
		const title = "<img src=x onerror=alert(1)>";
		const harness = await mounted(
			withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11, { title })])]),
		);

		const tree = treeOf(harness.root, "alpha");

		expect(tree?.querySelector(".t")?.textContent).toBe(title);
		expect(tree?.querySelector("img")).toBeNull();
		harness.handle.destroy();
	});

	test("keeps the full text of a 120-character title in the title attribute", async () => {
		const title = "w".repeat(120);
		const harness = await mounted(
			withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11, { title })])]),
		);

		const cell = treeOf(harness.root, "alpha")?.querySelector(".t");

		expect(cell?.getAttribute("title")).toBe(title);
		harness.handle.destroy();
	});

	test("the title cell shrinks and ellipsizes in the stylesheet", () => {
		const rules = [...popupCss.matchAll(/([^{}]+)\{([^}]*)\}/g)]
			.filter(([, selector]) => /\.tree[^,]*\.t\b/.test(selector as string))
			.map(([, , body]) => body)
			.join(";");

		expect(rules).toMatch(/min-width:\s*0/);
		expect(rules).toMatch(/text-overflow:\s*ellipsis/);
		expect(rules).toMatch(/overflow:\s*hidden/);
	});

	test("renders every tab and run row and marks the selected tab", async () => {
		const tabs = Array.from({ length: 7 }, (_, i) => tabRow(20 + i, { selected: i === 6 }));
		const busy = session({ sessionId: ALPHA_ID, agentIdentity: "alpha", runs: [run({ sessionId: ALPHA_ID })] });
		const harness = await mounted(withTabs([busy], [groupOf(ALPHA_ID, "blue", tabs)]));

		const tree = treeOf(harness.root, "alpha");
		const rows = tabItems(tree);

		expect(rows).toHaveLength(7);
		expect(rows.map((row) => row.classList.contains("act"))).toEqual([
			false, false, false, false, false, false, true,
		]);
		expect(rows[6]?.getAttribute("aria-current")).toBe("true");
		expect(tree?.querySelectorAll("li.run")).toHaveLength(1);
		harness.handle.destroy();
	});

	test("the tree scrolls inside a max height in the stylesheet", () => {
		const rules = [...popupCss.matchAll(/([^{}]+)\{([^}]*)\}/g)]
			.filter(([, selector]) => (selector as string).trim() === ".tree")
			.map(([, , body]) => body)
			.join(";");

		expect(rules).toMatch(/max-height:\s*\d+px/);
		expect(rules).toMatch(/overflow-y:\s*auto/);
	});

	test.each([
		["a file tab", "file:///tmp/notes.txt", ""],
		["a chrome page", "chrome://settings/", ""],
		["a blank page", "about:blank", ""],
		["an ftp tab", "ftp://files.example.test/a", "files.example.test"],
		["an unparsable url", "not a url", ""],
	])("renders the host of %s", async (_name, url, host) => {
		const harness = await mounted(
			withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11, { url })])]),
		);

		expect(treeOf(harness.root, "alpha")?.querySelector(".mono")?.textContent).toBe(host);
		harness.handle.destroy();
	});

	test("shows each agent only its own tabs", async () => {
		const harness = await mounted(
			withTabs(
				[alpha, beta],
				[
					groupOf(ALPHA_ID, "blue", [tabRow(11, { title: "alpha tab" })]),
					groupOf(BETA_ID, "red", [tabRow(21, { title: "beta tab" })]),
				],
			),
		);

		expect(treeOf(harness.root, "alpha")?.textContent).toContain("alpha tab");
		expect(treeOf(harness.root, "alpha")?.textContent).not.toContain("beta tab");
		expect(treeOf(harness.root, "beta")?.textContent).toContain("beta tab");
		expect(treeOf(harness.root, "beta")?.textContent).not.toContain("alpha tab");
		harness.handle.destroy();
	});

	describe("group color", () => {
		const squareOf = (root: HTMLElement, identity: string) =>
			cardOf(root, identity).querySelector('[aria-hidden="true"]');

		test("shows an aria-hidden square before the identity and names the color in the accessible text", async () => {
			const harness = await mounted(
				withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11)])]),
			);
			const card = cardOf(harness.root, "alpha");
			const square = squareOf(harness.root, "alpha");
			const order = [...card.querySelectorAll("*")];

			expect(square?.getAttribute("aria-hidden")).toBe("true");
			expect(square?.textContent).toBe("");
			expect(order.indexOf(square as Element)).toBeLessThan(
				order.indexOf(card.querySelector("b") as Element),
			);
			expect(accessibleText(card)).toContain("alpha, blue group");
			harness.handle.destroy();
		});

		test("renders a different square for every group color", async () => {
			const squares = new Set<string>();
			for (const color of GROUP_COLORS) {
				const harness = await mounted(
					withTabs([alpha], [groupOf(ALPHA_ID, color, [tabRow(11)])]),
				);
				squares.add(squareOf(harness.root, "alpha")?.outerHTML ?? "");
				expect(accessibleText(cardOf(harness.root, "alpha"))).toContain(`${color} group`);
				harness.handle.destroy();
			}

			expect(squares.size).toBe(GROUP_COLORS.length);
		});

		test.each(GROUP_COLORS)(
			"the stylesheet styles .gc-%s for light and for dark",
			(color) => {
				const dark = [
					...popupCss.matchAll(/@media \(prefers-color-scheme: dark\)\s*\{([\s\S]*?)\n\}/g),
				]
					.map(([, body]) => body)
					.join("\n");
				const light = popupCss.replace(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\n\}/g, "");
				const rule = new RegExp(`\\.gc-${color}\\s*\\{[^}]*background:`);

				expect(light).toMatch(rule);
				expect(dark).toMatch(rule);
			},
		);

		test("hides the swatch and the screen-reader group text when no group record exists", async () => {
			const harness = await mounted(withTabs([alpha], []));

			const card = cardOf(harness.root, "alpha");

			expect(card.querySelector<HTMLElement>(".swatch")?.hidden).toBe(true);
			expect(card.querySelector(".sr")?.textContent).toBe("");
			expect(accessibleText(card)).not.toContain("group");
			harness.handle.destroy();
		});

		test("falls back to grey when a group record has an unknown color", async () => {
			const harness = await mounted(
				withTabs([alpha], [groupOf(ALPHA_ID, "chartreuse", [tabRow(11)])]),
			);

			const card = cardOf(harness.root, "alpha");

			expect(card.querySelector<HTMLElement>(".swatch")?.hidden).toBe(false);
			expect(card.querySelector(".swatch")?.classList.contains("gc-grey")).toBe(true);
			expect(accessibleText(card)).toContain("grey group");
			harness.handle.destroy();
		});

		test("an unknown color still renders the card without throwing", async () => {
			const harness = await mounted(
				withTabs([alpha], [groupOf(ALPHA_ID, "chartreuse", [tabRow(11)])]),
			);

			expect(cardOf(harness.root, "alpha")).toBeDefined();
			harness.handle.destroy();
		});
	});

	describe("Add this tab", () => {
		const inGroup = (...ids: number[]) =>
			ids.map((id) => tabRow(id, { selected: false }));

		test("sends agentTabAdopt with the active tab id, session id and identity, then re-requests the list", async () => {
			const harness = await mounted(
				withTabs([alpha, beta], [groupOf(ALPHA_ID, "blue", []), groupOf(BETA_ID, "red", [])]),
				{ tabId: 7 },
			);
			const before = harness.sent(MSG.agentTabsRequest).length;

			await openAgentMenu(harness, "beta");
			const item = menuItemOf(harness.root, "Add this tab");
			expect(item).toBeDefined();
			expect(item?.getAttribute("aria-disabled")).toBeNull();
			item?.click();
			await settle();

			expect(harness.sent(MSG.agentTabAdopt)).toEqual([
				{ type: MSG.agentTabAdopt, sessionId: BETA_ID, agentIdentity: "beta", tabId: 7 },
			]);
			expect(harness.sent(MSG.agentTabsRequest).length).toBeGreaterThan(before);
			harness.handle.destroy();
		});

		test("a refused adopt shows the reply error inside that card", async () => {
			const harness = await mounted(
				{
					...withTabs([alpha, beta], [groupOf(ALPHA_ID, "blue", []), groupOf(BETA_ID, "red", [])]),
					replies: { [MSG.agentTabAdopt]: { ok: false, error: "incognito tabs cannot be shared" } },
				},
				{ tabId: 7 },
			);

			await openAgentMenu(harness, "beta");
			menuItemOf(harness.root, "Add this tab")?.click();
			await settle();

			expect(cardOf(harness.root, "beta").querySelector(".note.err")?.textContent).toBe(
				"incognito tabs cannot be shared",
			);
			expect(cardOf(harness.root, "alpha").querySelector(".note.err")).toBeNull();
			harness.handle.destroy();
		});

		test("keeps Open chat first in the menu", async () => {
			const harness = await mounted(withTabs([alpha], [groupOf(ALPHA_ID, "blue", [])]));

			await openAgentMenu(harness, "alpha");

			const labels = [...harness.root.querySelectorAll("[role='menuitem']")].map((item) =>
				item.textContent?.trim(),
			);
			expect(labels[0]).toBe("Open chat");
			expect(labels.some((label) => label?.includes("Add this tab"))).toBe(true);
			harness.handle.destroy();
		});

		test.each([
			["there is no active tab", { noActiveTab: true }],
			["the active tab has no id", { tab: { url: PAGE_URL } }],
		])("is disabled when %s", async (_name, options) => {
			const harness = await mounted(
				withTabs([alpha], [groupOf(ALPHA_ID, "blue", [])]),
				options as BootOptions,
			);

			await openAgentMenu(harness, "alpha");
			const item = menuItemOf(harness.root, "Add this tab");
			item?.click();
			await settle();

			expect(item?.getAttribute("aria-disabled")).toBe("true");
			expect(harness.sent(MSG.agentTabAdopt)).toHaveLength(0);
			harness.handle.destroy();
		});

		test.each([
			["an incognito tab", { id: 7, url: PAGE_URL, incognito: true }],
			["a chrome:// page", { id: 7, url: "chrome://extensions/" }],
			["a web store page", { id: 7, url: "https://chromewebstore.google.com/detail/x" }],
			["a Proton Mail tab", { id: 7, url: "https://mail.proton.me/u/0/inbox" }],
			["a tab with no url", { id: 7 }],
		])("is disabled with a reason for %s", async (_name, tab) => {
			const harness = await mounted(
				withTabs([alpha], [groupOf(ALPHA_ID, "blue", [])]),
				{ tab },
			);

			await openAgentMenu(harness, "alpha");
			const item = menuItemOf(harness.root, "Add this tab");
			item?.click();
			await settle();

			expect(item?.getAttribute("aria-disabled")).toBe("true");
			expect(reasonOf(item).trim().length).toBeGreaterThan("Add this tab".length);
			expect(harness.sent(MSG.agentTabAdopt)).toHaveLength(0);
			harness.handle.destroy();
		});

		test("is disabled with the owner's name when the tab sits in a busy agent's group", async () => {
			const harness = await mounted(
				withTabs(
					[{ ...alpha, runs: [run({ sessionId: ALPHA_ID })] }, beta],
					[groupOf(ALPHA_ID, "blue", inGroup(7)), groupOf(BETA_ID, "red", [])],
				),
				{ tabId: 7 },
			);

			await openAgentMenu(harness, "beta");
			const item = menuItemOf(harness.root, "Add this tab");
			item?.click();
			await settle();

			expect(item?.getAttribute("aria-disabled")).toBe("true");
			expect(reasonOf(item)).toContain("alpha is using this tab");
			expect(harness.sent(MSG.agentTabAdopt)).toHaveLength(0);
			harness.handle.destroy();
		});

		test("stays enabled when the tab sits in another agent's group and that agent has no runs", async () => {
			const harness = await mounted(
				withTabs(
					[alpha, beta],
					[groupOf(ALPHA_ID, "blue", inGroup(7)), groupOf(BETA_ID, "red", [])],
				),
				{ tabId: 7 },
			);

			await openAgentMenu(harness, "beta");
			const item = menuItemOf(harness.root, "Add this tab");

			expect(item).toBeDefined();
			expect(item?.getAttribute("aria-disabled")).toBeNull();
			harness.handle.destroy();
		});

		test("reads Select this tab for a tab already in the agent's group and sends the adopt message", async () => {
			const harness = await mounted(
				withTabs(
					[{ ...alpha, runs: [run({ sessionId: ALPHA_ID })] }],
					[groupOf(ALPHA_ID, "blue", inGroup(7))],
				),
				{ tabId: 7 },
			);

			await openAgentMenu(harness, "alpha");
			const item = menuItemOf(harness.root, "Select this tab");

			expect(menuItemOf(harness.root, "Add this tab")).toBeUndefined();
			expect(item).toBeDefined();
			expect(item?.getAttribute("aria-disabled")).toBeNull();
			item?.click();
			await settle();
			expect(harness.sent(MSG.agentTabAdopt)).toEqual([
				{ type: MSG.agentTabAdopt, sessionId: ALPHA_ID, agentIdentity: "alpha", tabId: 7 },
			]);
			harness.handle.destroy();
		});

		test("never moves a tab itself: the popup source calls neither tabs.group nor innerHTML", () => {
			const source = readFileSync(
				new URL("../lib/features/popup.ts", import.meta.url),
				"utf8",
			);

			expect(source).not.toMatch(/tabs\.group/);
			expect(source).not.toMatch(/innerHTML/);
		});
	});

	describe("live update", () => {
		test("a tick issues both requests and renders once the pair has answered", async () => {
			jest.useFakeTimers();
			const harness = boot(withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11, { title: "old" })])]));
			await harness.handle.ready;
			await flush();
			const connections = harness.sent(MSG.connectionRequest).length;
			const lists = harness.sent(MSG.agentTabsRequest).length;
			let release: () => void = () => undefined;
			harness.world.holdTabs = new Promise<void>((resolve) => {
				release = resolve;
			});
			harness.world.connection = paired({ ...alpha, runs: [run({ sessionId: ALPHA_ID })] })
				.connection as Row;
			harness.world.agentTabs = { groups: [groupOf(ALPHA_ID, "blue", [tabRow(11, { title: "new" })])] };

			jest.advanceTimersByTime(2000);
			await flush();

			expect(harness.sent(MSG.connectionRequest).length).toBe(connections + 1);
			expect(harness.sent(MSG.agentTabsRequest).length).toBe(lists + 1);
			expect(cardOf(harness.root, "alpha").querySelector(".pill")?.textContent?.trim()).toBe("Connected");
			expect(treeOf(harness.root, "alpha")?.textContent).toContain("old");

			release();
			await flush();

			expect(cardOf(harness.root, "alpha").querySelector(".pill")?.textContent?.trim()).toBe("Working");
			expect(treeOf(harness.root, "alpha")?.textContent).toContain("new");
			expect(treeOf(harness.root, "alpha")?.textContent).not.toContain("old");
			harness.handle.destroy();
		});

		test("an open menu survives the tick", async () => {
			jest.useFakeTimers();
			const harness = boot(withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11)])]));
			await harness.handle.ready;
			await flush();
			const trigger = harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu for alpha"]');
			trigger?.click();
			await flush();
			const panel = harness.root.querySelector("[role='menu']");
			harness.world.agentTabs = {
				groups: [groupOf(ALPHA_ID, "blue", [tabRow(11), tabRow(12)])],
			};

			jest.advanceTimersByTime(2000);
			await flush();

			expect(trigger?.getAttribute("aria-expanded")).toBe("true");
			expect(harness.root.querySelector("[role='menu']")).toBe(panel);
			expect(tabItems(treeOf(harness.root, "alpha"))).toHaveLength(2);
			harness.handle.destroy();
		});

		test("a rejected agentTabsRequest keeps the previous tab rows while the pills still update", async () => {
			jest.useFakeTimers();
			const harness = boot(withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11, { title: "kept" })])]));
			await harness.handle.ready;
			await flush();
			harness.world.tabsFail = true;
			harness.world.connection = paired({ ...alpha, runs: [run({ sessionId: ALPHA_ID })] })
				.connection as Row;

			jest.advanceTimersByTime(2000);
			await flush();

			expect(treeOf(harness.root, "alpha")?.textContent).toContain("kept");
			expect(cardOf(harness.root, "alpha").querySelector(".pill")?.textContent?.trim()).toBe("Working");
			harness.handle.destroy();
		});

		test("drops a late agentTabsRequest reply after destroy without rendering", async () => {
			jest.useFakeTimers();
			let release: () => void = () => undefined;
			const hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			const harness = boot({
				...withTabs([alpha], [groupOf(ALPHA_ID, "blue", [tabRow(11, { title: "ghost tab" })])]),
				holdTabs: hold,
			});
			harness.handle.destroy();

			release();
			await flush();

			expect(harness.root.textContent).not.toContain("ghost tab");
			expect(harness.root.querySelectorAll(".ag")).toHaveLength(0);
		});

		test("an in-flight adopt suppresses the next tick and forces a re-read when it settles", async () => {
			jest.useFakeTimers();
			let release: () => void = () => undefined;
			const harness = boot(
				withTabs([alpha], [groupOf(ALPHA_ID, "blue", [])]),
				{ tabId: 7 },
			);
			await harness.handle.ready;
			await flush();
			harness.world.holdAdopt = new Promise<void>((resolve) => {
				release = resolve;
			});
			harness.root.querySelector<HTMLButtonElement>('[aria-label="Menu for alpha"]')?.click();
			await flush();
			menuItemOf(harness.root, "Add this tab")?.click();
			await flush();
			const connections = harness.sent(MSG.connectionRequest).length;
			const lists = harness.sent(MSG.agentTabsRequest).length;

			jest.advanceTimersByTime(4000);
			await flush();

			expect(harness.sent(MSG.connectionRequest)).toHaveLength(connections);
			expect(harness.sent(MSG.agentTabsRequest)).toHaveLength(lists);

			harness.world.agentTabs = {
				groups: [groupOf(ALPHA_ID, "blue", [tabRow(7, { selected: true, title: "adopted" })])],
			};
			release();
			await flush();

			expect(harness.sent(MSG.connectionRequest).length).toBeGreaterThan(connections);
			expect(harness.sent(MSG.agentTabsRequest).length).toBeGreaterThan(lists);
			expect(treeOf(harness.root, "alpha")?.textContent).toContain("adopted");
			harness.handle.destroy();
		});
	});
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
	type ChatFrame,
	type OverwatchAction,
	type OverwatchBoard,
	type OverwatchLane,
} from "@dg/common";
import { Window } from "happy-dom";
import type { OverwatchActionResult } from "@dg/pages/board/overwatch";
import { click } from "./utils/dom-events";
import { captureGlobal } from "./utils/relay-harness";
import {
	DemoVerifyHarness,
	resolveBrowserBinary,
} from "../../skills-cli/src/utils/cdp-harness";

let storedSessions: Record<string, unknown> = {};

mock.module("wxt/browser", () => ({
	browser: {
		storage: { session: { get: () => Promise.resolve(storedSessions) } },
	},
}));

const { renderOverwatchPage } = await import("../entrypoints/overwatch/main");
const { mountPairing } = await import("@/lib/features/pairing");
const { handleOverwatchFrame, handleOverwatchFrameSafely } = await import(
	"@/lib/background/chat"
);
const { MSG } = await import("@dg/pages/chat-messages");
const {
	connectOverwatchApi,
	createOverwatchApi,
	formatCountdown,
	needYouCount,
} = await import("@dg/pages/board/overwatch");

const NOW = new Date("2026-10-02T10:30:00.000Z");
const GEOMETRY_TEST_TIMEOUT_MS = 60_000;
const browserAvailable = (() => {
	if (process.env.PW_E2E !== "1") return false;
	try {
		resolveBrowserBinary();
		return true;
	} catch {
		return false;
	}
})();

function buildLane(overrides: Partial<OverwatchLane> = {}): OverwatchLane {
	return {
		chat: "print",
		task: "Follow ups after scheduling",
		stage: "e2e",
		mr: "!298",
		eta: "1h",
		kind: "chat",
		publisher: "print-agent",
		updatedAt: "2026-10-02T10:28:00.000Z",
		...overrides,
	};
}

function buildBoard(overrides: Partial<OverwatchBoard> = {}): OverwatchBoard {
	return {
		goLive: "2026-10-04T12:45:00.000Z",
		goNoGo: "2026-10-03T15:00:00.000Z",
		lanes: [buildLane()],
		merges: [],
		...overrides,
	};
}

const testWindows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...testWindows].map((window) => window.happyDOM.close()));
	testWindows.clear();
});

function newRoot(): HTMLElement {
	const window = new Window();
	testWindows.add(window);
	const document = window.document as unknown as Document;
	const root = document.createElement("div");
	document.body.append(root);
	return root as unknown as HTMLElement;
}

type RuntimeListener = (message: unknown) => void;

function runtimeHarness() {
	let listener: RuntimeListener | undefined;
	return {
		runtime: {
			onMessage: {
				addListener(next: RuntimeListener) {
					listener = next;
				},
				removeListener(next: RuntimeListener) {
					if (listener === next) listener = undefined;
				},
			},
		},
		emit(board: OverwatchBoard) {
			listener?.({
				type: MSG.overwatchState,
				frame: {
					type: "overwatch-state",
					sessionId: OVERWATCH_SESSION_ID,
					protocolVersion: CHAT_PROTOCOL_VERSION,
					board,
				},
			});
		},
	};
}

function button(root: HTMLElement, name: string): HTMLButtonElement {
	const match = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
		(candidate) => candidate.textContent === name,
	);
	if (!match) throw new Error(`button not found: ${name}`);
	return match;
}

async function mount(
	board: OverwatchBoard = buildBoard(),
	actionResult: OverwatchActionResult = { ok: true },
) {
	const root = newRoot();
	const relay = runtimeHarness();
	const actions: OverwatchAction[] = [];
	const api = {
		baseUrl: "http://127.0.0.1:47823",
		getBoard: () => Promise.resolve(board),
		sendAction: (action: OverwatchAction) => {
			actions.push(action);
			return Promise.resolve(actionResult);
		},
	};
	const handle = renderOverwatchPage({
		root,
		runtime: relay.runtime,
		connect: () => Promise.resolve(api),
		now: () => NOW,
		schedule: () => 1,
		cancel: () => undefined,
	});
	await handle.ready;
	return { root, relay, actions, handle };
}

async function inspectNarrowLayout(markup: string): Promise<{
	documentWidth: number;
	viewportWidth: number;
	nodesFit: boolean;
	hasProhibitedBorder: boolean;
	pairVariantCount: number;
	pairVariantsFit: boolean;
	pairLabelsNowrap: boolean;
}> {
	const directory = await mkdtemp(join(tmpdir(), "dg-overwatch-page-layout-"));
	const path = join(directory, "overwatch.html");
	const optionsCss = readFileSync(
		new URL("../entrypoints/options/style.css", import.meta.url),
		"utf8",
	);
	const chatCss = readFileSync(
		new URL("../../pages/src/chat/style.css", import.meta.url),
		"utf8",
	);
	const overwatchCss = readFileSync(
		new URL("../../pages/src/board/style.css", import.meta.url),
		"utf8",
	);
	await writeFile(
		path,
		`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<style>${optionsCss}\n${chatCss}\n${overwatchCss}</style>
</head>
<body>
	${markup}
</body>
</html>`,
	);
	let harness: DemoVerifyHarness | undefined;
	try {
		harness = await DemoVerifyHarness.launch();
		const page = await harness.openPage(pathToFileURL(path).href);
		try {
			await page.setViewport(390, 844);
			return await page.evaluate<{
				documentWidth: number;
				viewportWidth: number;
				nodesFit: boolean;
				hasProhibitedBorder: boolean;
				pairVariantCount: number;
				pairVariantsFit: boolean;
				pairLabelsNowrap: boolean;
			}>(`(() => {
				const nodes = [...document.querySelectorAll(".overwatch__who small,.overwatch__next,.overwatch__background-lane p,.overwatch__asks")];
				const all = [...document.querySelectorAll("*")];
				const pairVariants = [...document.querySelectorAll("[data-pair-variant]")];
				const pairNodes = pairVariants.flatMap((variant) => [variant, ...variant.querySelectorAll("*")]).filter((node) => getComputedStyle(node).display !== "none");
				const pairLabels = pairVariants.flatMap((variant) => [...variant.querySelectorAll(".pair-form__label")]);
				return {
					documentWidth: document.documentElement.scrollWidth,
					viewportWidth: document.documentElement.clientWidth,
					nodesFit: nodes.every((node) => node.clientWidth > 0 && node.scrollWidth <= node.clientWidth),
					hasProhibitedBorder: all.some((node) => {
						const style = getComputedStyle(node);
						return [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle].some((value) => value === "dashed" || value === "dotted");
					}),
					pairVariantCount: pairVariants.length,
					pairVariantsFit: pairNodes.every((node) => {
						const rect = node.getBoundingClientRect();
						return rect.left >= 0 && rect.right <= document.documentElement.clientWidth && node.scrollWidth <= node.clientWidth;
					}),
					pairLabelsNowrap: pairLabels.every((node) => getComputedStyle(node).whiteSpace === "nowrap"),
				};
			})()`);
		} finally {
			page.dispose();
		}
	} finally {
		try {
			await harness?.close();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	}
}

async function renderPairingVariant(
	name: "options" | "chat" | "overwatch",
): Promise<string> {
	const root = newRoot();
	root.dataset.pairVariant = name;
	if (name === "chat") root.className = "chat-pair";
	if (name === "overwatch") root.className = "overwatch__pair";
	const handle = mountPairing(root, {
		variant: name === "options" ? "options" : "entry",
		runtime: {
			sendMessage: mock(() => Promise.resolve({ connected: false })),
		},
		findPort: () => Promise.resolve(47823),
		fetch: () => Promise.resolve(new Response("", { status: 409 })),
	});
	await handle.ready;
	if (name !== "options") click(button(root, "Pair"));
	const input = root.querySelector<HTMLInputElement>("input");
	if (!input) throw new Error("pairing input not found");
	input.value = "123456";
	const EventConstructor = root.ownerDocument.defaultView?.Event;
	if (!EventConstructor) throw new Error("event constructor not found");
	root.querySelector("form")?.dispatchEvent(
		new EventConstructor("submit", { bubbles: true, cancelable: true }),
	);
	await Bun.sleep(0);
	if (!root.textContent?.includes("Paired to another extension")) {
		throw new Error("pairing status did not render");
	}
	const markup = root.outerHTML;
	handle.destroy();
	return name === "overwatch"
		? `<section class="overwatch">${markup}</section>`
		: markup;
}

describe("the overwatch page", () => {
	test("renders one lane per chat with the current stage active", async () => {
		const { root, handle } = await mount(
			buildBoard({
				lanes: [
					buildLane(),
					buildLane({ chat: "infra", stage: "ci", publisher: "infra-agent" }),
				],
			}),
		);

		expect(root.querySelectorAll(".overwatch__lane")).toHaveLength(2);
		const active = root.querySelector(
			"[data-key=\"infra\"] .overwatch__cell--now",
		) as HTMLElement;
		expect(active.dataset.stage).toBe("CI");
		expect(active.textContent).toBe("active");
		handle.stop();
	});

	test("removes a missing lane from a later state without replacing the page", async () => {
		const { root, relay, handle } = await mount(
			buildBoard({
				lanes: [
					buildLane(),
					buildLane({ chat: "infra", publisher: "infra-agent" }),
				],
			}),
		);
		const shell = root.firstElementChild;

		relay.emit(buildBoard({ lanes: [buildLane({ chat: "infra" })] }));

		expect(root.firstElementChild).toBe(shell);
		expect(root.querySelectorAll(".overwatch__lane")).toHaveLength(1);
		expect(root.querySelector("[data-key=\"print\"]")).toBeNull();
		handle.stop();
	});

	test("sends exactly one approve POST with the lane chat", async () => {
		const restoreFetch = captureGlobal("fetch");
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchStub = mock(
			(input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return Promise.resolve(
					init?.method === "POST"
						? Response.json({ ok: true })
						: Response.json(buildBoard()),
				);
			},
		);
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: fetchStub,
		});
		const root = newRoot();
		const relay = runtimeHarness();
		const handle = renderOverwatchPage({
			root,
			runtime: relay.runtime,
			connect: () =>
				Promise.resolve(createOverwatchApi("http://127.0.0.1:47823")),
			now: () => NOW,
			schedule: () => 1,
			cancel: () => undefined,
		});
		try {
			await handle.ready;
			click(button(root, "Actions"));
			click(button(root, "Approve"));
			await Bun.sleep(0);

			const posts = requests.filter(
				(request) => request.init?.method === "POST",
			);
			expect(posts).toHaveLength(1);
			expect(posts[0]?.url).toBe(
				"http://127.0.0.1:47823/overwatch/action",
			);
			expect(posts[0]?.init?.body).toBe(
				JSON.stringify({ chat: "print", action: "approve" }),
			);
			expect(root.querySelector(".overwatch__action-status")?.textContent).toBe(
				"Sent",
			);
		} finally {
			handle.stop();
			restoreFetch();
		}
	});

	test("blocks a reject until its note is present", async () => {
		const { root, actions, handle } = await mount();

		click(button(root, "Actions"));
		click(button(root, "Reject"));
		click(button(root, "Send rejection"));
		await Bun.sleep(0);

		expect(actions).toEqual([]);
		expect(root.querySelector("[role=\"alert\"]")?.textContent).toContain(
			"note is required",
		);
		handle.stop();
	});

	test("allows only one action request per lane while a request is pending", async () => {
		let resolveAction: ((result: OverwatchActionResult) => void) | undefined;
		const pending = new Promise<OverwatchActionResult>((resolve) => {
			resolveAction = resolve;
		});
		const root = newRoot();
		const relay = runtimeHarness();
		const sendAction = mock(() => pending);
		const handle = renderOverwatchPage({
			root,
			runtime: relay.runtime,
			connect: () =>
				Promise.resolve({
					baseUrl: "http://127.0.0.1:47823",
					getBoard: () => Promise.resolve(buildBoard()),
					sendAction,
				}),
			now: () => NOW,
			schedule: () => 1,
			cancel: () => undefined,
		});
		await handle.ready;

		click(button(root, "Actions"));
		const approve = button(root, "Approve");
		click(approve);
		click(approve);
		await Bun.sleep(0);

		expect(sendAction).toHaveBeenCalledTimes(1);
		expect(approve.disabled).toBe(true);
		resolveAction?.({ ok: true });
		await Bun.sleep(0);
		expect(approve.disabled).toBe(false);
		handle.stop();
	});

	test("shows an error toast when the daemon rejects an action", async () => {
		const { root, handle } = await mount(buildBoard(), {
			ok: false,
			error: "no such overwatch lane",
		});

		click(button(root, "Actions"));
		click(button(root, "Approve"));
		await Bun.sleep(0);

		const toast = root.querySelector(".overwatch__toast") as HTMLElement;
		expect(toast.hidden).toBe(false);
		expect(toast.textContent).toBe("no such overwatch lane");
		handle.stop();
	});

	test("shows the empty state when no lanes are reporting", async () => {
		const { root, handle } = await mount(buildBoard({ lanes: [] }));

		expect(root.querySelectorAll(".overwatch__lane")).toHaveLength(0);
		expect((root.querySelector(".overwatch__empty") as HTMLElement).hidden).toBe(
			false,
		);
		handle.stop();
	});

	test("shows the launch-lane empty state when only background lanes exist", async () => {
		const { root, handle } = await mount(
			buildBoard({ lanes: [buildLane({ kind: "background" })] }),
		);

		expect(root.querySelectorAll(".overwatch__lane")).toHaveLength(0);
		expect((root.querySelector(".overwatch__empty") as HTMLElement).hidden).toBe(
			false,
		);
		handle.stop();
	});

	test("puts background lanes and today's merges in the footer", async () => {
		const { root, handle } = await mount(
			buildBoard({
				lanes: [
					buildLane(),
					buildLane({
						chat: "arch",
						kind: "background",
						next: "sign in to Proton",
					}),
				],
				merges: [
					{ mr: "!300", title: "stage 2FA", at: NOW.toISOString() },
				],
			}),
		);

		expect(root.querySelectorAll(".overwatch__lane")).toHaveLength(1);
		expect(root.querySelector(".overwatch__background")?.textContent).toContain(
			"arch",
		);
		expect(root.querySelector(".overwatch__merges")?.textContent).toContain(
			"!300 stage 2FA",
		);
		expect(root.querySelector(".overwatch__need")?.textContent).toBe(
			"1 NEED YOU",
		);
		handle.stop();
	});

	test("removes every prohibited dash glyph from visible board data", async () => {
		const dashes = "-‐‑‒–—―−─";
		const { root, handle } = await mount(
			buildBoard({
				lanes: [
					buildLane({
						chat: `chat${dashes}`,
						task: `task${dashes}`,
						mr: `!1${dashes}`,
						eta: `soon${dashes}`,
						next: `approve${dashes}`,
					}),
					buildLane({
						chat: `background${dashes}`,
						kind: "background",
					}),
				],
				merges: [
					{
						mr: `!2${dashes}`,
						title: `merged${dashes}`,
						at: NOW.toISOString(),
					},
				],
			}),
		);

		expect(root.querySelector(".overwatch")?.textContent).not.toMatch(
			/[-‐‑‒–—―−─]/,
		);
		handle.stop();
	});

	test("uses ordinary disclosure buttons with an explicit controlled region", async () => {
		const { root, handle } = await mount();
		const trigger = button(root, "Actions");
		const controlled = root.querySelector(
			`#${trigger.getAttribute("aria-controls")}`,
		);

		expect(controlled).not.toBeNull();
		expect(controlled?.getAttribute("role")).toBeNull();
		expect(button(root, "Approve").getAttribute("role")).toBeNull();
		handle.stop();
	});

	test("shows the chat status pill when the daemon is unreachable", async () => {
		const root = newRoot();
		const relay = runtimeHarness();
		const handle = renderOverwatchPage({
			root,
			runtime: relay.runtime,
			connect: () => Promise.resolve(undefined),
			now: () => NOW,
			schedule: () => 1,
			cancel: () => undefined,
		});

		await handle.ready;

		const pill = root.querySelector(".chat-rail__connection") as HTMLElement;
		expect(pill.hidden).toBe(false);
		expect(pill.getAttribute("role")).toBe("status");
		expect(pill.textContent).toBe("Daemon unreachable");
		handle.stop();
	});

	test("shows Pair while unpaired and keeps confirmation visible when connected", async () => {
		const root = newRoot();
		const listeners = new Set<RuntimeListener>();
		const runtime = {
			onMessage: {
				addListener(listener: RuntimeListener) {
					listeners.add(listener);
				},
				removeListener(listener: RuntimeListener) {
					listeners.delete(listener);
				},
			},
			sendMessage: mock(() => Promise.resolve({ connected: false })),
		};
		const handle = renderOverwatchPage({
			root,
			runtime,
			connect: () =>
				Promise.resolve({
					baseUrl: "http://127.0.0.1:47823",
					getBoard: () => Promise.resolve(buildBoard()),
					sendAction: () => Promise.resolve({ ok: true as const }),
				}),
			now: () => NOW,
			schedule: () => 1,
			cancel: () => undefined,
		});
		await handle.ready;
		await Promise.resolve();

		const pair = root.querySelector<HTMLElement>(".overwatch__pair");
		expect(pair?.hidden).toBe(false);
		expect(pair?.textContent).toContain("Not paired");

		runtime.sendMessage.mockImplementation(() => Promise.resolve({ connected: true }));
		for (const listener of listeners) {
			listener({ type: MSG.connection, state: "connected", connected: true, sessions: [] });
		}
		await Promise.resolve();
		expect(pair?.hidden).toBe(false);
		expect(pair?.textContent).toContain("connection confirmed");
		handle.stop();
	});

	test("shows Pair when board loading returns the unpaired 400 response", async () => {
		const restoreFetch = captureGlobal("fetch");
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: mock(() =>
				Promise.resolve(
					new Response("refused: no authenticated extension origin is pinned", {
						status: 400,
					}),
				),
			),
		});
		const root = newRoot();
		const listeners = new Set<RuntimeListener>();
		const runtime = {
			onMessage: {
				addListener(listener: RuntimeListener) {
					listeners.add(listener);
				},
				removeListener(listener: RuntimeListener) {
					listeners.delete(listener);
				},
			},
			sendMessage: mock(() => Promise.resolve({ connected: false })),
		};
		const handle = renderOverwatchPage({
			root,
			runtime,
			connect: () =>
				Promise.resolve(createOverwatchApi("http://127.0.0.1:47823")),
			now: () => NOW,
			schedule: () => 1,
			cancel: () => undefined,
		});
		try {
			await handle.ready;
			await Promise.resolve();

			const pair = root.querySelector<HTMLElement>(".overwatch__pair");
			expect(pair?.hidden).toBe(false);
			expect(pair?.textContent).toContain("Not paired");
		} finally {
			handle.stop();
			restoreFetch();
		}
	});

	test("retries a failed initial load with a bounded reconciliation timer", async () => {
		const root = newRoot();
		const relay = runtimeHarness();
		const retries: Array<() => void> = [];
		const cancelDeferred = mock(() => undefined);
		let connectCount = 0;
		const handle = renderOverwatchPage({
			root,
			runtime: relay.runtime,
			connect: () => {
				connectCount += 1;
				return Promise.resolve(
					connectCount === 1
						? undefined
						: {
								baseUrl: "http://127.0.0.1:47823",
								getBoard: () => Promise.resolve(buildBoard()),
								sendAction: () => Promise.resolve({ ok: true as const }),
							},
				);
			},
			now: () => NOW,
			schedule: () => 1,
			cancel: () => undefined,
			defer: (callback) => {
				retries.push(callback);
				return retries.length;
			},
			cancelDeferred,
		});
		await handle.ready;
		expect(retries).toHaveLength(1);

		retries[0]?.();
		await Bun.sleep(0);
		await Bun.sleep(0);

		expect(connectCount).toBe(2);
		expect(root.querySelectorAll(".overwatch__lane")).toHaveLength(1);
		handle.stop();
		expect(cancelDeferred).not.toHaveBeenCalled();
	});

	test("cancels a pending reconciliation retry when the page stops", async () => {
		const root = newRoot();
		const relay = runtimeHarness();
		const cancelDeferred = mock(() => undefined);
		const handle = renderOverwatchPage({
			root,
			runtime: relay.runtime,
			connect: () => Promise.resolve(undefined),
			now: () => NOW,
			schedule: () => 1,
			cancel: () => undefined,
			defer: () => 42,
			cancelDeferred,
		});
		await handle.ready;

		handle.stop();

		expect(cancelDeferred).toHaveBeenCalledWith(42);
	});

	test("invalidates an unreachable action API before the next action", async () => {
		const root = newRoot();
		const relay = runtimeHarness();
		let connectCount = 0;
		const firstAction = mock(() =>
			Promise.resolve({ ok: false as const, error: "Daemon unreachable" }),
		);
		const secondAction = mock(() => Promise.resolve({ ok: true as const }));
		const handle = renderOverwatchPage({
			root,
			runtime: relay.runtime,
			connect: () => {
				connectCount += 1;
				return Promise.resolve({
					baseUrl: `http://127.0.0.1:${47822 + connectCount}`,
					getBoard: () => Promise.resolve(buildBoard()),
					sendAction: connectCount === 1 ? firstAction : secondAction,
				});
			},
			now: () => NOW,
			schedule: () => 1,
			cancel: () => undefined,
		});
		await handle.ready;
		click(button(root, "Actions"));
		click(button(root, "Approve"));
		await Bun.sleep(0);
		click(button(root, "Approve"));
		await Bun.sleep(0);

		expect(connectCount).toBe(2);
		expect(firstAction).toHaveBeenCalledTimes(1);
		expect(secondAction).toHaveBeenCalledTimes(1);
		handle.stop();
	});
});

test.skipIf(!browserAvailable)(
	"keeps maximal board and Pair prose visible at a 390 pixel viewport",
	async () => {
		const { root, handle } = await mount(
			buildBoard({
				lanes: [
					buildLane({
						chat: "c".repeat(40),
						task: "t".repeat(80),
						mr: "m".repeat(80),
						eta: "e".repeat(80),
						next: "n".repeat(200),
					}),
					buildLane({
						chat: "b".repeat(40),
						task: "q".repeat(80),
						kind: "background",
						eta: "r".repeat(80),
						next: "s".repeat(200),
					}),
				],
			}),
		);
		try {
			const pairingMarkup = (
				await Promise.all([
					renderPairingVariant("options"),
					renderPairingVariant("chat"),
					renderPairingVariant("overwatch"),
				])
			).join("");
			const geometry = await inspectNarrowLayout(
				`${root.innerHTML}${pairingMarkup}`,
			);
			expect(geometry.viewportWidth).toBe(390);
			expect(geometry.documentWidth).toBeLessThanOrEqual(390);
			expect(geometry.nodesFit).toBe(true);
			expect(geometry.hasProhibitedBorder).toBe(false);
			expect(geometry.pairVariantCount).toBe(3);
			expect(geometry.pairVariantsFit).toBe(true);
			expect(geometry.pairLabelsNowrap).toBe(true);
		} finally {
			handle.stop();
		}
	},
	GEOMETRY_TEST_TIMEOUT_MS,
);

describe("overwatch frame handling", () => {
	test("relays an overwatch state under the dedicated runtime message", async () => {
		const sendMessage = mock(() => Promise.resolve());
		const frame = {
			type: "overwatch-state" as const,
			sessionId: OVERWATCH_SESSION_ID,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			board: buildBoard(),
		} satisfies ChatFrame;

		await handleOverwatchFrame(frame, {
			runtime: {
				getURL: (path: string) => `chrome-extension://test/${path}`,
				sendMessage,
			},
			tabs: { create: mock(() => Promise.resolve()) },
		});

		expect(sendMessage).toHaveBeenCalledWith({
			type: MSG.overwatchState,
			frame,
		});
	});

	test("focuses an existing board tab and its window without creating another", async () => {
		const query = mock(() => Promise.resolve([{ id: 12, windowId: 7 }]));
		const updateTab = mock(() => Promise.resolve());
		const updateWindow = mock(() => Promise.resolve());
		const create = mock(() => Promise.resolve());
		const api = {
			runtime: {
				getURL: (path: string) => `chrome-extension://test/${path}`,
				sendMessage: mock(() => Promise.resolve()),
			},
			tabs: { query, update: updateTab, create },
			windows: { update: updateWindow },
		};

		await handleOverwatchFrame(
			{
				type: "overwatch-open",
				sessionId: OVERWATCH_SESSION_ID,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: "open-request-0",
			},
			api,
		);

		expect(updateTab).toHaveBeenCalledWith(12, { active: true });
		expect(updateWindow).toHaveBeenCalledWith(7, { focused: true });
		expect(create).not.toHaveBeenCalled();
	});

	test("creates the board tab when none exists", async () => {
		const create = mock(() => Promise.resolve());
		const api = {
			runtime: {
				getURL: (path: string) => `chrome-extension://test/${path}`,
				sendMessage: mock(() => Promise.resolve()),
			},
			tabs: {
				query: mock(() => Promise.resolve([])),
				update: mock(() => Promise.resolve()),
				create,
			},
			windows: { update: mock(() => Promise.resolve()) },
		};

		await handleOverwatchFrame(
			{
				type: "overwatch-open",
				sessionId: OVERWATCH_SESSION_ID,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: "open-request-1",
			},
			api,
		);

		expect(create).toHaveBeenCalledWith({
			url: "chrome-extension://test/overwatch.html",
		});
	});

	test("reports a tab creation failure through the correlated completion", async () => {
		const completions: unknown[] = [];
		const create = mock(() => Promise.reject(new Error("tab creation failed")));
		const originalError = console.error;
		console.error = mock(() => undefined);
		try {
			await handleOverwatchFrameSafely(
				{
					type: "overwatch-open",
					sessionId: OVERWATCH_SESSION_ID,
					protocolVersion: CHAT_PROTOCOL_VERSION,
					requestId: "open-request-2",
				},
				{
					runtime: {
						getURL: (path: string) => `chrome-extension://test/${path}`,
						sendMessage: mock(() => Promise.resolve()),
					},
					tabs: { query: mock(() => Promise.resolve([])), create },
				},
				(result) => completions.push(result),
			);
		} finally {
			console.error = originalError;
		}

		expect(completions).toEqual([
			{
				requestId: "open-request-2",
				ok: false,
				error: "tab creation failed",
			},
		]);
	});

	test("treats an absent overwatch page listener as an expected state broadcast", async () => {
		const frame = {
			type: "overwatch-state" as const,
			sessionId: OVERWATCH_SESSION_ID,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			board: buildBoard(),
		} satisfies ChatFrame;

		await expect(
			handleOverwatchFrame(frame, {
				runtime: {
					getURL: (path: string) => `chrome-extension://test/${path}`,
					sendMessage: () =>
						Promise.reject(new Error("Receiving end does not exist")),
				},
				tabs: { create: mock(() => Promise.resolve()) },
			}),
		).resolves.toBeUndefined();
	});
});

test("a pinned-origin HTTP error is surfaced instead of scanning fallback ports", async () => {
	const restoreFetch = captureGlobal("fetch");
	const fetchStub = mock(() =>
		Promise.resolve(new Response("origin pin required", { status: 400 })),
	);
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		value: fetchStub,
	});
	try {
		await expect(connectOverwatchApi(47823)).rejects.toThrow(
			"origin pin required",
		);
		expect(fetchStub).toHaveBeenCalledTimes(1);
	} finally {
		restoreFetch();
	}
});

test("the countdown and need-you count derive from board data", () => {
	const board = buildBoard({
		lanes: [
			buildLane({ next: "choose layout" }),
			buildLane({ chat: "infra", next: "grant access" }),
			buildLane({ chat: "arch", kind: "background" }),
		],
	});

	expect(formatCountdown(board.goLive, NOW)).toBe("2d 02h 15m");
	expect(needYouCount(board.lanes)).toBe(2);
});

describe("board reads from the extension page", () => {
	const BOARD_JSON = JSON.stringify({ lanes: [], merges: [] });

	async function readHeaders(): Promise<Headers[]> {
		const restoreFetch = captureGlobal("fetch");
		const seen: Headers[] = [];
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: (_url: string, init?: RequestInit) => {
				seen.push(new Headers(init?.headers));
				return Promise.resolve(new Response(BOARD_JSON));
			},
		});
		try {
			const handle = renderOverwatchPage({
				root: newRoot(),
				runtime: runtimeHarness().runtime,
				schedule: () => 1,
				cancel: () => undefined,
			});
			await handle.ready;
			handle.stop();
		} finally {
			restoreFetch();
		}
		return seen;
	}

	afterEach(() => {
		storedSessions = {};
	});

	test("sends the stored session token as a Bearer header", async () => {
		storedSessions = {
			"chat_session:session-a": {
				port: 47823,
				sessionId: "session-a",
				token: "tok-a",
				agentIdentity: "claude",
			},
			unrelated: { token: "not-a-session" },
		};

		const seen = await readHeaders();

		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]?.get("authorization")).toBe("Bearer tok-a");
	});

	test("sends the token of a session spawned by New chat once the original session entry is gone", async () => {
		storedSessions = {
			"chat_session:session-b": {
				port: 47823,
				sessionId: "session-b",
				token: "tok-b",
				agentIdentity: "claude",
			},
		};

		const seen = await readHeaders();

		expect(seen[0]?.get("authorization")).toBe("Bearer tok-b");
	});

	test("sends no Authorization header when no session is stored", async () => {
		const seen = await readHeaders();

		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]?.get("authorization")).toBeNull();
	});
});

describe("board token stays with its own daemon port", () => {
	type Call = { url: string; authorization: string | null };

	function stubFetch(respond: (url: string) => Promise<Response>): {
		calls: Call[];
		restore: () => void;
	} {
		const restore = captureGlobal("fetch");
		const calls: Call[] = [];
		Object.defineProperty(globalThis, "fetch", {
			configurable: true,
			value: (url: string, init?: RequestInit) => {
				calls.push({
					url,
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return respond(url);
			},
		});
		return { calls, restore };
	}

	afterEach(() => {
		storedSessions = {};
	});

	test("sends no token to a port that port discovery found", async () => {
		const { calls, restore } = stubFetch((url) => {
			if (url === "http://127.0.0.1:47824/healthz") {
				return Promise.resolve(
					Response.json({ daemon: "dg-daemon", instanceId: "other" }),
				);
			}
			if (url === "http://127.0.0.1:47824/overwatch") {
				return Promise.resolve(Response.json({ lanes: [], merges: [] }));
			}
			return Promise.reject(new TypeError("Failed to fetch"));
		});
		try {
			const api = await connectOverwatchApi(47823, "tok-a");
			await api?.getBoard();
		} finally {
			restore();
		}

		expect(
			calls.find((call) => call.url === "http://127.0.0.1:47823/overwatch")
				?.authorization,
		).toBe("Bearer tok-a");
		const discovered = calls.filter(
			(call) => call.url === "http://127.0.0.1:47824/overwatch",
		);
		expect(discovered.length).toBeGreaterThan(0);
		for (const call of discovered) expect(call.authorization).toBeNull();
	});

	test("reads from the stored session's port and moves to a newly stored session on another port", async () => {
		storedSessions = {
			"chat_session:session-a": {
				port: 47900,
				sessionId: "session-a",
				token: "tok-a",
				agentIdentity: "claude",
			},
		};
		let up = true;
		const { calls, restore } = stubFetch((url) =>
			up && url.endsWith("/overwatch")
				? Promise.resolve(Response.json({ lanes: [], merges: [] }))
				: Promise.reject(new TypeError("Failed to fetch")),
		);
		try {
			const handle = renderOverwatchPage({
				root: newRoot(),
				runtime: runtimeHarness().runtime,
				schedule: () => 1,
				cancel: () => undefined,
				defer: () => 1,
				cancelDeferred: () => undefined,
			});
			await handle.ready;
			expect(calls[0]).toEqual({
				url: "http://127.0.0.1:47900/overwatch",
				authorization: "Bearer tok-a",
			});

			storedSessions = {
				"chat_session:session-b": {
					port: 47901,
					sessionId: "session-b",
					token: "tok-b",
					agentIdentity: "claude",
				},
			};
			up = false;
			await handle.refresh();
			up = true;
			calls.length = 0;
			await handle.refresh();
			handle.stop();
		} finally {
			restore();
		}

		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call).toEqual({
				url: "http://127.0.0.1:47901/overwatch",
				authorization: "Bearer tok-b",
			});
		}
	});

	test("tries the next stored token for the port when the daemon refuses the first", async () => {
		const bootstrap = (sessionId: string, token: string) => ({
			port: 47900,
			sessionId,
			token,
			agentIdentity: "claude",
		});
		storedSessions = {
			"chat_session:session-old": bootstrap("session-old", "tok-old"),
			"chat_session:session-live": bootstrap("session-live", "tok-live"),
		};
		const { calls, restore } = stubFetch((url) => {
			const last = calls.at(-1);
			if (url.endsWith("/overwatch") && last?.authorization === "Bearer tok-live") {
				return Promise.resolve(Response.json({ lanes: [], merges: [] }));
			}
			return Promise.resolve(new Response("refused", { status: 403 }));
		});
		try {
			const handle = renderOverwatchPage({
				root: newRoot(),
				runtime: runtimeHarness().runtime,
				schedule: () => 1,
				cancel: () => undefined,
				defer: () => 1,
				cancelDeferred: () => undefined,
			});
			await handle.ready;
			handle.stop();
		} finally {
			restore();
		}

		expect(calls.map((call) => call.authorization)).toEqual([
			"Bearer tok-old",
			"Bearer tok-live",
			"Bearer tok-live",
		]);
	});

	test("tries the next stored session when the first one's daemon is offline", async () => {
		storedSessions = {
			"chat_session:session-gone": {
				port: 47900,
				sessionId: "session-gone",
				token: "tok-gone",
				agentIdentity: "claude",
			},
			"chat_session:session-live": {
				port: 47901,
				sessionId: "session-live",
				token: "tok-live",
				agentIdentity: "claude",
			},
		};
		const { calls, restore } = stubFetch((url) =>
			url === "http://127.0.0.1:47901/overwatch"
				? Promise.resolve(Response.json({ lanes: [], merges: [] }))
				: Promise.reject(new TypeError("Failed to fetch")),
		);
		try {
			const handle = renderOverwatchPage({
				root: newRoot(),
				runtime: runtimeHarness().runtime,
				schedule: () => 1,
				cancel: () => undefined,
				defer: () => 1,
				cancelDeferred: () => undefined,
			});
			await handle.ready;
			handle.stop();
		} finally {
			restore();
		}

		expect(calls.filter((call) => call.url.endsWith("/healthz"))).toEqual([]);
		expect(calls.at(-1)).toEqual({
			url: "http://127.0.0.1:47901/overwatch",
			authorization: "Bearer tok-live",
		});
	});

	describe("when the previous port stops serving the board", () => {
		const bootstrap = (port: number, name: string) => ({
			port,
			sessionId: `session-${name}`,
			token: `tok-${name}`,
			agentIdentity: "claude",
		});

		async function reconnectAfter(
			failPreviousPort: () => Promise<Response>,
		): Promise<Call[]> {
			storedSessions = {
				"chat_session:session-a": bootstrap(47900, "a"),
				"chat_session:session-b": bootstrap(47901, "b"),
			};
			let previousPortDown = false;
			const { calls, restore } = stubFetch((url) =>
				url === "http://127.0.0.1:47900/overwatch" && previousPortDown
					? failPreviousPort()
					: url.endsWith("/overwatch")
						? Promise.resolve(Response.json({ lanes: [], merges: [] }))
						: Promise.reject(new TypeError("Failed to fetch")),
			);
			try {
				const handle = renderOverwatchPage({
					root: newRoot(),
					runtime: runtimeHarness().runtime,
					schedule: () => 1,
					cancel: () => undefined,
					defer: () => 1,
					cancelDeferred: () => undefined,
				});
				await handle.ready;
				expect(calls[0]).toEqual({
					url: "http://127.0.0.1:47900/overwatch",
					authorization: "Bearer tok-a",
				});
				previousPortDown = true;
				await handle.refresh();
				calls.length = 0;
				await handle.refresh();
				handle.stop();
			} finally {
				restore();
			}
			return calls;
		}

		function expectTokensStayOnTheirPorts(calls: Call[]) {
			const tokenByPort: Record<string, string> = {
				"47900": "Bearer tok-a",
				"47901": "Bearer tok-b",
			};
			for (const call of calls) {
				if (call.authorization === null) continue;
				const port = new URL(call.url).port;
				expect(call.authorization).toBe(tokenByPort[port]);
			}
		}

		test("falls through to a live session on another port when the previous port is offline", async () => {
			const calls = await reconnectAfter(() =>
				Promise.reject(new TypeError("Failed to fetch")),
			);

			expect(calls[0]).toEqual({
				url: "http://127.0.0.1:47900/overwatch",
				authorization: "Bearer tok-a",
			});
			expect(calls.at(-1)).toEqual({
				url: "http://127.0.0.1:47901/overwatch",
				authorization: "Bearer tok-b",
			});
			expectTokensStayOnTheirPorts(calls);
		});

		test("falls through to a live session on another port when the previous port refuses", async () => {
			const calls = await reconnectAfter(() =>
				Promise.resolve(new Response("refused", { status: 403 })),
			);

			expect(calls[0]).toEqual({
				url: "http://127.0.0.1:47900/overwatch",
				authorization: "Bearer tok-a",
			});
			expect(calls.at(-1)).toEqual({
				url: "http://127.0.0.1:47901/overwatch",
				authorization: "Bearer tok-b",
			});
			expectTokensStayOnTheirPorts(calls);
		});
	});
});


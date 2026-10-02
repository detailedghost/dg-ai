import { describe, expect, mock, test } from "bun:test";
import {
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
	type ChatFrame,
	type OverwatchAction,
	type OverwatchBoard,
	type OverwatchLane,
} from "@dg/common";
import { Window } from "happy-dom";
import type { OverwatchActionResult } from "@/lib/features/overwatch";
import { click } from "./utils/dom-events";
import { captureGlobal } from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const { renderOverwatchPage } = await import("../entrypoints/overwatch/main");
const { handleOverwatchFrame } = await import("@/lib/background/chat");
const { MSG } = await import("@/lib/chat-messages");
const { createOverwatchApi, formatCountdown, needYouCount } = await import(
	"@/lib/features/overwatch"
);

const NOW = new Date("2026-10-02T10:30:00.000Z");

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

function newRoot(): HTMLElement {
	const window = new Window();
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
			'[data-key="infra"] .overwatch__cell--now',
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
		expect(root.querySelector('[data-key="print"]')).toBeNull();
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
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			"note is required",
		);
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
});

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
			},
			api,
		);

		expect(create).toHaveBeenCalledWith({
			url: "chrome-extension://test/overwatch.html",
		});
	});
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

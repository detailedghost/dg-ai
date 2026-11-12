import { expect, mock, test } from "bun:test";
import { CHAT_PROTOCOL_VERSION, type ChatFrame } from "@dg/common";
import { Window } from "happy-dom";
import { canvasPositionKey } from "../src/chat/chat-canvas";
import { renderChatPage as renderSharedChatPage } from "../src/chat/main";
import type { PositionArea } from "../src/runtime";
import { click, fire, flushMicrotasks, pointer } from "./utils/dom-events";
import { buildSessionListFrame } from "./utils/frame-fixtures";
import { makePositionArea } from "./utils/position-area";

let positionArea: PositionArea;

function stubPositions(initial: Record<string, unknown> = {}) {
	const stub = makePositionArea(initial);
	positionArea = stub.area;
	return stub.data;
}

function renderChatPage(
	options: Parameters<typeof renderSharedChatPage>[0],
): Promise<void> {
	return renderSharedChatPage({ positionArea, ...options });
}

function newRoot(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	const root = document.createElement("div");
	document.body.appendChild(root);
	return root as unknown as HTMLElement;
}

type FrameListener = (frame: ChatFrame) => void;

function makeFakeClient() {
	const listeners = new Set<FrameListener>();
	return {
		client: {
			connect: mock(() => {}),
			onConnectionChange: () => {},
			onFrame(listener: FrameListener) {
				listeners.add(listener);
			},
			sendUserMessage: mock(() => "message-id"),
			getConnectionState: () => "connected" as const,
			closeSession: mock(() => {}),
		},
		emit(frame: ChatFrame) {
			for (const listener of listeners) listener(frame);
		},
	};
}

function sessionListFrame(ids: string[]): ChatFrame {
	return buildSessionListFrame(
		ids.map((sessionId) => ({
			sessionId,
			agentIdentity: `agent-${sessionId}`,
		})),
	) as ChatFrame;
}

function bootstraps() {
	return [
		{
			port: 47823,
			sessionId: "session-a",
			token: "tok-a",
			agentIdentity: "agent-session-a",
		},
	];
}

async function openCanvas(
	root: HTMLElement,
	fake: ReturnType<typeof makeFakeClient>,
	ids: string[],
): Promise<void> {
	await renderChatPage({
		root,
		createClient: () => fake.client as never,
		loadBootstraps: async () => bootstraps(),
	});
	fake.emit(sessionListFrame(ids));
	click(
		root.querySelector(
			"[data-action='toggle-canvas']",
		) as unknown as HTMLElement,
	);
	await flushMicrotasks(10);
}

function boardNode(root: HTMLElement, sessionId: string): HTMLElement | null {
	return root.querySelector(
		`.chat-canvas__board [data-session-id='${sessionId}']`,
	) as unknown as HTMLElement | null;
}

test("each live session's node moves onto the board when the canvas opens", async () => {
	stubPositions();
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a", "session-b"]);

	expect(boardNode(root, "session-a")).not.toBeNull();
	expect(boardNode(root, "session-b")).not.toBeNull();
	expect(root.querySelectorAll(".chat-thread__nodes .chat-node").length).toBe(
		0,
	);
});

test("a node with a saved position appears at exactly that position", async () => {
	stubPositions({
		[canvasPositionKey("session-a")]: { x: 420, y: 260 },
	});
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a"]);

	const node = boardNode(root, "session-a");
	expect(node?.style.left).toBe("420px");
	expect(node?.style.top).toBe("260px");
	expect(node?.style.position).toBe("absolute");
});

test("nodes with no saved position get distinct default slots rather than stacking at the origin", async () => {
	stubPositions();
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a", "session-b", "session-c"]);

	const positions = ["session-a", "session-b", "session-c"].map((id) => {
		const node = boardNode(root, id);
		return `${node?.style.left},${node?.style.top}`;
	});
	expect(new Set(positions).size).toBe(3);
});

test("dragging a node moves it and persists the new position", async () => {
	const data = stubPositions({
		[canvasPositionKey("session-a")]: { x: 100, y: 100 },
	});
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a"]);

	const handle = root.querySelector(
		"[data-session-id='session-a'] [data-action='drag-node']",
	) as unknown as HTMLElement;
	expect(handle).toBeDefined();

	pointer(handle, "pointerdown", { clientX: 100, clientY: 100 });
	pointer(handle, "pointermove", { clientX: 150, clientY: 190 });
	pointer(handle, "pointerup", { clientX: 150, clientY: 190 });
	await flushMicrotasks(10);

	const node = boardNode(root, "session-a");
	expect(node?.style.left).toBe("150px");
	expect(node?.style.top).toBe("190px");
	expect(data[canvasPositionKey("session-a")]).toEqual({ x: 150, y: 190 });
});

test("dragging a node pans neither the board nor the other nodes", async () => {
	stubPositions({
		[canvasPositionKey("session-a")]: { x: 100, y: 100 },
		[canvasPositionKey("session-b")]: { x: 500, y: 100 },
	});
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a", "session-b"]);
	const board = root.querySelector(".chat-canvas__board") as HTMLElement;
	const before = board.style.transform;

	const handle = root.querySelector(
		"[data-session-id='session-a'] [data-action='drag-node']",
	) as unknown as HTMLElement;
	pointer(handle, "pointerdown", { clientX: 100, clientY: 100 });
	pointer(handle, "pointermove", { clientX: 140, clientY: 140 });
	pointer(handle, "pointerup", { clientX: 140, clientY: 140 });

	expect(board.style.transform).toBe(before);
	expect(boardNode(root, "session-b")?.style.left).toBe("500px");
});

test("focusing a node parked far off-view pans the board until it is in view", async () => {
	stubPositions({
		[canvasPositionKey("session-a")]: { x: 0, y: 0 },
		[canvasPositionKey("session-b")]: { x: 9000, y: 7000 },
	});
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a", "session-b"]);
	const board = root.querySelector(".chat-canvas__board") as HTMLElement;
	const before = board.style.transform;

	const node = boardNode(root, "session-b") as HTMLElement;
	const input = node.querySelector(
		".chat-composer__input",
	) as unknown as HTMLElement;
	fire(input, "focusin");

	expect(board.style.transform).not.toBe(before);
	expect(board.style.transform).toContain("translate(");
});

test("switching back to the rail returns the nodes to the thread pane and drops their board positions", async () => {
	stubPositions();
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a"]);
	expect(boardNode(root, "session-a")).not.toBeNull();

	click(
		root.querySelector(
			"[data-action='toggle-canvas']",
		) as unknown as HTMLElement,
	);

	expect(boardNode(root, "session-a")).toBeNull();
	const node = root.querySelector(
		".chat-thread__nodes .chat-node",
	) as unknown as HTMLElement;
	expect(node).toBeDefined();
	expect(node.style.position).toBe("");
});

test("a closed session's stored position is pruned rather than left behind forever", async () => {
	const data = stubPositions({
		[canvasPositionKey("session-a")]: { x: 10, y: 10 },
		[canvasPositionKey("session-gone")]: { x: 20, y: 20 },
	});
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a"]);

	expect(canvasPositionKey("session-gone") in data).toBe(false);
	expect(canvasPositionKey("session-a") in data).toBe(true);
});

test("focusing a node already in view leaves the board where it is, so the canvas does not jerk on every focus", async () => {
	stubPositions({
		[canvasPositionKey("session-a")]: { x: 120, y: 120 },
	});
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a"]);
	const board = root.querySelector(".chat-canvas__board") as HTMLElement;
	const before = board.style.transform;

	const input = boardNode(root, "session-a")?.querySelector(
		".chat-composer__input",
	) as unknown as HTMLElement;
	fire(input, "focusin");

	expect(board.style.transform).toBe(before);
});

test("a session that closes mid-drag cancels the drag instead of persisting a position for a node that is gone", async () => {
	const data = stubPositions({
		[canvasPositionKey("session-a")]: { x: 100, y: 100 },
	});
	const root = newRoot();
	const fake = makeFakeClient();
	await openCanvas(root, fake, ["session-a", "session-b"]);

	const handle = root.querySelector(
		"[data-session-id='session-a'] [data-action='drag-node']",
	) as unknown as HTMLElement;
	pointer(handle, "pointerdown", { clientX: 100, clientY: 100 });
	pointer(handle, "pointermove", { clientX: 150, clientY: 190 });

	fake.emit({
		type: "session-closed",
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
	} as ChatFrame);

	pointer(handle, "pointermove", { clientX: 900, clientY: 900 });
	pointer(handle, "pointerup", { clientX: 900, clientY: 900 });
	await flushMicrotasks(10);

	expect(boardNode(root, "session-a")).toBeNull();
	expect(data[canvasPositionKey("session-a")]).toEqual({ x: 100, y: 100 });
});

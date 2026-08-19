/**
 * lib/features/chat-canvas.ts: the optional pan/zoom board — pure viewport
 * arithmetic plus wheel/motion/persistence wiring. No implementation exists
 * yet; every exported name here is this RED pass's own invention, pinned by
 * these tests per plan.md slice 11's testability constraint (injected
 * viewport, no rect reads — happy-dom has no layout engine).
 */

import { expect, mock, test } from "bun:test";
import { Window } from "happy-dom";

const {
	MIN_SCALE,
	MAX_SCALE,
	PAN_BOUND,
	clampScale,
	clampPan,
	screenToBoard,
	boardToScreen,
	applyDragDelta,
	isNodeInView,
	canvasPositionKey,
	loadNodePositions,
	saveNodePosition,
	createChatCanvas,
} = await import("@/lib/features/chat-canvas");

type Point = { x: number; y: number };
type Viewport = { scale: number; pan: Point; width: number; height: number };

function baseViewport(overrides: Partial<Viewport> = {}): Viewport {
	return {
		scale: 1,
		pan: { x: 0, y: 0 },
		width: 800,
		height: 600,
		...overrides,
	};
}

function newCanvasHost(): { container: HTMLElement; document: Document } {
	const window = new Window();
	const document = window.document as unknown as Document;
	const container = document.createElement("div") as unknown as HTMLElement;
	return { container, document };
}

type FakeWheelWindow = {
	WheelEvent: new (type: string, init?: Record<string, unknown>) => Event;
};

function windowOf(container: HTMLElement): FakeWheelWindow {
	return container.ownerDocument.defaultView as unknown as FakeWheelWindow;
}

// happy-dom's WheelEvent ctor drops MouseEvent modifier keys from its init
// dict, so ctrlKey has to be assigned after construction, not passed in.
function wheelEvent(
	win: FakeWheelWindow,
	init: { deltaY?: number; ctrlKey?: boolean } = {},
): Event {
	const event = new win.WheelEvent("wheel", {
		deltaY: init.deltaY ?? 10,
		bubbles: true,
		cancelable: true,
	});
	if (init.ctrlKey) (event as unknown as { ctrlKey: boolean }).ctrlKey = true;
	return event;
}

// Backs a hand-rolled chrome.storage.local — returns the live object so tests
// can assert pruning actually removed a key, not just that the return value omitted it.
function stubChromeStorage(
	initial: Record<string, unknown> = {},
): Record<string, unknown> {
	const data: Record<string, unknown> = { ...initial };
	(globalThis as any).chrome = {
		storage: {
			local: {
				get: mock(async (keys?: string | string[] | null) => {
					if (keys === undefined || keys === null) return { ...data };
					const ks = Array.isArray(keys) ? keys : [keys];
					const result: Record<string, unknown> = {};
					for (const k of ks) if (k in data) result[k] = data[k];
					return result;
				}),
				set: mock(async (items: Record<string, unknown>) => {
					Object.assign(data, items);
				}),
				remove: mock(async (keys: string | string[]) => {
					const ks = Array.isArray(keys) ? keys : [keys];
					for (const k of ks) delete data[k];
				}),
			},
		},
	};
	return data;
}

// --- clampScale / clampPan (Contract: bounds hold for representative inputs) ---

test("clampScale clamps a value below MIN_SCALE up to MIN_SCALE", () => {
	expect(clampScale(MIN_SCALE - 1)).toBe(MIN_SCALE);
});

test("clampScale clamps a value above MAX_SCALE down to MAX_SCALE", () => {
	expect(clampScale(MAX_SCALE + 5)).toBe(MAX_SCALE);
});

test("clampScale leaves an in-range value unchanged", () => {
	const mid = (MIN_SCALE + MAX_SCALE) / 2;
	expect(clampScale(mid)).toBe(mid);
});

test("clampPan clamps each axis independently at PAN_BOUND", () => {
	expect(clampPan({ x: PAN_BOUND + 1, y: -PAN_BOUND - 1 })).toEqual({
		x: PAN_BOUND,
		y: -PAN_BOUND,
	});
});

test("clampPan leaves an ordinary pan unchanged — the board itself is unbounded", () => {
	expect(clampPan({ x: 12345, y: -6789 })).toEqual({ x: 12345, y: -6789 });
});

// --- screenToBoard / boardToScreen (Contract: round-trip a point) ---

test("boardToScreen applies the viewport's scale and pan, not an identity pass-through", () => {
	const viewport = baseViewport({ scale: 2, pan: { x: 50, y: -30 } });
	expect(boardToScreen({ x: 100, y: 50 }, viewport)).toEqual({ x: 250, y: 70 });
});

test("screenToBoard(boardToScreen(p)) round-trips a board point", () => {
	const viewport = baseViewport({ scale: 2, pan: { x: 50, y: -30 } });
	const boardPoint = { x: 100, y: 50 };
	const screenPoint = boardToScreen(boardPoint, viewport);
	expect(screenToBoard(screenPoint, viewport)).toEqual(boardPoint);
});

test("boardToScreen(screenToBoard(p)) round-trips a screen point", () => {
	const viewport = baseViewport({ scale: 2, pan: { x: 50, y: -30 } });
	const screenPoint = { x: 250, y: 70 };
	const boardPoint = screenToBoard(screenPoint, viewport);
	expect(boardToScreen(boardPoint, viewport)).toEqual(screenPoint);
});

// --- applyDragDelta (named by the testability constraint; pure, no listed checkbox) ---

test("applyDragDelta shifts pan by the screen-space delta without mutating the input viewport", () => {
	const viewport = baseViewport({ scale: 1.5, pan: { x: 20, y: -10 } });
	const result = applyDragDelta(viewport, { x: 30, y: 40 });
	expect(result.pan).toEqual({ x: 50, y: 30 });
	expect(result.scale).toBe(1.5);
	expect(viewport.pan).toEqual({ x: 20, y: -10 });
});

test("applyDragDelta clamps the resulting pan at PAN_BOUND", () => {
	const viewport = baseViewport({ pan: { x: PAN_BOUND - 5, y: 0 } });
	const result = applyDragDelta(viewport, { x: 100, y: 0 });
	expect(result.pan.x).toBe(PAN_BOUND);
});

// --- Node position persistence (per-session, restored on load, orphans pruned) ---

test("saveNodePosition persists a position that loadNodePositions restores on a later load", async () => {
	stubChromeStorage();
	await saveNodePosition("session-a", { x: 12, y: 34 });
	const restored = await loadNodePositions(["session-a"]);
	expect(restored.get("session-a")).toEqual({ x: 12, y: 34 });
});

test("loadNodePositions prunes an orphaned session's stored position from storage and the result", async () => {
	const data = stubChromeStorage({
		[canvasPositionKey("session-live")]: { x: 1, y: 2 },
		[canvasPositionKey("session-orphan")]: { x: 9, y: 9 },
	});
	const restored = await loadNodePositions(["session-live"]);
	expect(restored.get("session-live")).toEqual({ x: 1, y: 2 });
	expect(restored.has("session-orphan")).toBe(false);
	expect(canvasPositionKey("session-orphan") in data).toBe(false);
});

// --- Wheel semantics: transcript scroll vs. board zoom ---

test("a plain wheel over a transcript descendant does not change the board's scale", () => {
	const { container, document } = newCanvasHost();
	const canvas = createChatCanvas(container, { viewport: baseViewport() });
	const transcript = document.createElement("div");
	transcript.className = "chat-transcript";
	canvas.boardElement.appendChild(transcript);
	const before = canvas.viewport().scale;

	const event = wheelEvent(windowOf(container), { deltaY: 40 });
	transcript.dispatchEvent(event);

	expect(canvas.viewport().scale).toBe(before);
	expect(event.defaultPrevented).toBe(false);
});

test("a ctrlKey wheel over the board is treated as zoom and calls preventDefault", () => {
	const { container } = newCanvasHost();
	const canvas = createChatCanvas(container, { viewport: baseViewport() });
	const before = canvas.viewport().scale;

	const event = wheelEvent(windowOf(container), { ctrlKey: true, deltaY: -40 });
	canvas.boardElement.dispatchEvent(event);

	expect(event.defaultPrevented).toBe(true);
	expect(canvas.viewport().scale).not.toBe(before);
});

// --- Reduced motion suppresses easing ---

test("data-motion=reduced on the container suppresses the board's transform transition", () => {
	const { container } = newCanvasHost();
	container.dataset.motion = "reduced";
	const canvas = createChatCanvas(container, { viewport: baseViewport() });

	canvas.boardElement.dispatchEvent(
		wheelEvent(windowOf(container), { ctrlKey: true, deltaY: -40 }),
	);

	expect(canvas.boardElement.style.transition).toBe("");
});

test("data-motion=full on the container applies an eased transform transition", () => {
	const { container } = newCanvasHost();
	container.dataset.motion = "full";
	const canvas = createChatCanvas(container, { viewport: baseViewport() });

	canvas.boardElement.dispatchEvent(
		wheelEvent(windowOf(container), { ctrlKey: true, deltaY: -40 }),
	);

	expect(canvas.boardElement.style.transition).not.toBe("");
});

// --- Board chrome is a sibling, never a descendant, of the transformed board ---

test("createChatCanvas mounts board and chrome as siblings; chrome is never nested inside the board", () => {
	const { container } = newCanvasHost();
	const canvas = createChatCanvas(container, { viewport: baseViewport() });

	expect(canvas.boardElement.parentElement).toBe(container);
	expect(canvas.chromeElement.parentElement).toBe(container);
	expect(canvas.boardElement.contains(canvas.chromeElement)).toBe(false);
	expect(canvas.boardElement.style.touchAction).toBe("none");
});

// --- isNodeInView (used by the page's pan-to-focused-node recovery) ---

test("isNodeInView is true for a node inside the visible viewport", () => {
	const viewport = baseViewport();
	expect(
		isNodeInView({ x: 50, y: 50, width: 100, height: 100 }, viewport),
	).toBe(true);
});

test("isNodeInView is false for a node dragged far outside the visible viewport", () => {
	const viewport = baseViewport();
	expect(
		isNodeInView({ x: 5000, y: 5000, width: 100, height: 100 }, viewport),
	).toBe(false);
});

test("isNodeInView applies pan, not raw board coordinates, to recover an off-view node", () => {
	// Same board x (5000) as the false case above, but pan shifts it on-screen —
	// proves the viewport transform is applied, not a raw-coordinate bounds check.
	const viewport = baseViewport({ pan: { x: -4900, y: 0 } });
	expect(
		isNodeInView({ x: 5000, y: 50, width: 100, height: 100 }, viewport),
	).toBe(true);
});

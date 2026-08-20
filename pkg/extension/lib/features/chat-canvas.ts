export type Point = { x: number; y: number };

export type Viewport = {
	scale: number;
	pan: Point;
	width: number;
	height: number;
};

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 3;
export const PAN_BOUND = 1_000_000;

const POSITION_PREFIX = "chat_pos:";
const WHEEL_GESTURE_MS = 120;
const FULL_MOTION_TRANSITION = "transform 120ms ease-out";

export function clampScale(scale: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function clampPan(pan: Point): Point {
	return {
		x: Math.min(PAN_BOUND, Math.max(-PAN_BOUND, pan.x)),
		y: Math.min(PAN_BOUND, Math.max(-PAN_BOUND, pan.y)),
	};
}

export function screenToBoard(point: Point, viewport: Viewport): Point {
	return {
		x: (point.x - viewport.pan.x) / viewport.scale,
		y: (point.y - viewport.pan.y) / viewport.scale,
	};
}

export function boardToScreen(point: Point, viewport: Viewport): Point {
	return {
		x: point.x * viewport.scale + viewport.pan.x,
		y: point.y * viewport.scale + viewport.pan.y,
	};
}

export function applyDragDelta(
	viewport: Viewport,
	screenDelta: Point,
): Viewport {
	return {
		...viewport,
		pan: clampPan({
			x: viewport.pan.x + screenDelta.x,
			y: viewport.pan.y + screenDelta.y,
		}),
	};
}

export function isNodeInView(
	nodeRect: { x: number; y: number; width: number; height: number },
	viewport: Viewport,
): boolean {
	const firstCorner = boardToScreen({ x: nodeRect.x, y: nodeRect.y }, viewport);
	const secondCorner = boardToScreen(
		{
			x: nodeRect.x + nodeRect.width,
			y: nodeRect.y + nodeRect.height,
		},
		viewport,
	);
	const left = Math.min(firstCorner.x, secondCorner.x);
	const right = Math.max(firstCorner.x, secondCorner.x);
	const top = Math.min(firstCorner.y, secondCorner.y);
	const bottom = Math.max(firstCorner.y, secondCorner.y);

	return (
		right >= 0 &&
		bottom >= 0 &&
		left <= viewport.width &&
		top <= viewport.height
	);
}

export function canvasPositionKey(sessionId: string): string {
	return `${POSITION_PREFIX}${sessionId}`;
}

export async function saveNodePosition(
	sessionId: string,
	position: Point,
): Promise<void> {
	await chrome.storage.local.set({ [canvasPositionKey(sessionId)]: position });
}

function isPoint(value: unknown): value is Point {
	return (
		typeof value === "object" &&
		value !== null &&
		"x" in value &&
		"y" in value &&
		typeof value.x === "number" &&
		typeof value.y === "number" &&
		Number.isFinite(value.x) &&
		Number.isFinite(value.y)
	);
}

export async function loadNodePositions(
	liveSessionIds: string[],
): Promise<Map<string, Point>> {
	const stored: Record<string, unknown> = await chrome.storage.local.get(null);
	const liveSessions = new Set(liveSessionIds);
	const positions = new Map<string, Point>();
	const orphanedKeys: string[] = [];

	for (const [key, value] of Object.entries(stored)) {
		if (!key.startsWith(POSITION_PREFIX)) continue;
		const sessionId = key.slice(POSITION_PREFIX.length);
		if (!liveSessions.has(sessionId)) {
			orphanedKeys.push(key);
			continue;
		}
		if (isPoint(value)) positions.set(sessionId, value);
	}

	if (orphanedKeys.length > 0) await chrome.storage.local.remove(orphanedKeys);

	return positions;
}

type ChatCanvas = {
	boardElement: HTMLElement;
	chromeElement: HTMLElement;
	viewport(): Viewport;
	panTo(pan: Point): void;
};

type DragState = {
	pointerId: number;
	lastPoint: Point;
};

function copyViewport(viewport: Viewport): Viewport {
	return {
		...viewport,
		scale: clampScale(viewport.scale),
		pan: clampPan(viewport.pan),
	};
}

function isTranscriptTarget(target: EventTarget | null): boolean {
	if (
		target === null ||
		!("closest" in target) ||
		typeof target.closest !== "function"
	)
		return false;
	return target.closest(".chat-transcript") !== null;
}

export function createChatCanvas(
	container: HTMLElement,
	options: { viewport: Viewport },
): ChatCanvas {
	const boardElement = container.ownerDocument.createElement("div");
	boardElement.className = "chat-canvas__board";
	boardElement.style.touchAction = "none";
	boardElement.style.transformOrigin = "0 0";

	const chromeElement = container.ownerDocument.createElement("div");
	chromeElement.className = "chat-canvas__chrome";

	container.appendChild(boardElement);
	container.appendChild(chromeElement);

	let currentViewport = copyViewport(options.viewport);
	let transformScheduled = false;
	let dragState: DragState | undefined;
	let wheelGestureTimer: ReturnType<typeof setTimeout> | undefined;

	const applyTransform = (): void => {
		transformScheduled = false;
		const { pan, scale } = currentViewport;
		boardElement.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
	};

	const scheduleTransform = (): void => {
		if (transformScheduled) return;
		if (typeof globalThis.requestAnimationFrame !== "function") {
			applyTransform();
			return;
		}
		transformScheduled = true;
		globalThis.requestAnimationFrame(applyTransform);
	};

	const updateWillChange = (): void => {
		boardElement.style.willChange =
			dragState || wheelGestureTimer !== undefined ? "transform" : "";
	};

	const beginWheelGesture = (): void => {
		if (wheelGestureTimer !== undefined) clearTimeout(wheelGestureTimer);
		wheelGestureTimer = setTimeout(() => {
			wheelGestureTimer = undefined;
			updateWillChange();
		}, WHEEL_GESTURE_MS);
		updateWillChange();
	};

	const finishDrag = (event: PointerEvent): void => {
		if (!dragState || event.pointerId !== dragState.pointerId) return;
		dragState = undefined;
		updateWillChange();
		container.ownerDocument.removeEventListener(
			"pointermove",
			handlePointerMove,
		);
		container.ownerDocument.removeEventListener("pointerup", finishDrag);
		container.ownerDocument.removeEventListener("pointercancel", finishDrag);
	};

	function handlePointerMove(event: PointerEvent): void {
		if (!dragState || event.pointerId !== dragState.pointerId) return;
		const nextPoint = { x: event.clientX, y: event.clientY };
		currentViewport = applyDragDelta(currentViewport, {
			x: nextPoint.x - dragState.lastPoint.x,
			y: nextPoint.y - dragState.lastPoint.y,
		});
		dragState.lastPoint = nextPoint;
		scheduleTransform();
	}

	boardElement.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || dragState || event.target !== boardElement)
			return;
		dragState = {
			pointerId: event.pointerId,
			lastPoint: { x: event.clientX, y: event.clientY },
		};
		boardElement.style.transition = "";
		updateWillChange();
		container.ownerDocument.addEventListener("pointermove", handlePointerMove);
		container.ownerDocument.addEventListener("pointerup", finishDrag);
		container.ownerDocument.addEventListener("pointercancel", finishDrag);
	});

	boardElement.addEventListener(
		"wheel",
		(event) => {
			if (!event.ctrlKey && isTranscriptTarget(event.target)) return;
			event.preventDefault();
			beginWheelGesture();
			boardElement.style.transition =
				container.dataset.motion === "reduced" ? "" : FULL_MOTION_TRANSITION;

			const focusPoint = {
				x: currentViewport.width / 2,
				y: currentViewport.height / 2,
			};
			const boardFocus = screenToBoard(focusPoint, currentViewport);
			const scale = clampScale(
				currentViewport.scale * Math.exp(-event.deltaY * 0.002),
			);
			currentViewport = {
				...currentViewport,
				scale,
				pan: clampPan({
					x: focusPoint.x - boardFocus.x * scale,
					y: focusPoint.y - boardFocus.y * scale,
				}),
			};
			scheduleTransform();
		},
		{ passive: false },
	);

	applyTransform();

	return {
		boardElement,
		chromeElement,
		viewport: () => copyViewport(currentViewport),
		panTo(pan: Point): void {
			currentViewport = { ...currentViewport, pan: clampPan(pan) };
			scheduleTransform();
		},
	};
}

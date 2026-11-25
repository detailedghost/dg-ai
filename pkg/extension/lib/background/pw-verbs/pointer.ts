import type { PwExtResponse } from "@dg/common";
import type { PointerRequest, PointerResult } from "@dg/common/pw-ext-verbs/pointer";
import type { AgentTabs } from "../agent-tabs";
import { allowedPage, mailbox, PW_EXT_BLOCKED_ERROR, PW_EXT_MAILBOX_ERROR, PW_EXT_PRIVATE_ERROR } from "../tab-guards";

type Result = { ok: true; data: PwExtResponse } | { ok: false; error: string };

type PointerAction =
	| { kind: "hover" | "dblclick"; target: string }
	| { kind: "drag"; target: string; to: string }
	| { kind: "mousemove"; x: number; y: number }
	| { kind: "mousedown" | "mouseup"; button: "left" | "middle" | "right" }
	| { kind: "mousewheel"; dx: number; dy: number };

type PointerBrowserApi = {
	tabs: {
		get(tabId: number): Promise<{ url?: string; incognito?: boolean; discarded?: boolean }>;
	};
	scripting: {
		executeScript(details: {
			target: { tabId: number };
			func: (...args: never[]) => unknown;
			args: unknown[];
		}): Promise<Array<{ result?: unknown }>>;
	};
};

const notInGroup = (tabId: number) =>
	`pw --ext: tab ${tabId} is not in this agent's tab group; run pw --ext tabs to list them.`;
const NO_TAB = "This agent has no selected tab. Run pw --ext tabs, then pw --ext select <id>.";

/** Self-contained action that scripting.executeScript runs in the tab's isolated world. */
export function pwExtPointerAction(action: PointerAction, expectUrl: string): PointerResult {
	const doc = document;
	const win = doc.defaultView as unknown as Window & Record<symbol, unknown>;
	const g = win as unknown as typeof globalThis;
	const REFS = Symbol.for("dg.pwExt.refs");
	const POINTER = Symbol.for("dg.pwExt.pointer");
	const BUTTONS = { left: 0, middle: 1, right: 2 } as const;
	const MASKS = { left: 1, middle: 4, right: 2 } as const;
	type Point = { x: number; y: number };

	const resolve = (target: string): Element | string => {
		let matches: Element[];
		if (/^e\d+$/.test(target)) {
			const found = (win[REFS] as Map<string, Element> | undefined)?.get(target);
			if (!found || !found.isConnected) return `Ref ${target} not found. Run dg pw --ext snapshot again.`;
			matches = [found];
		} else {
			try {
				matches = Array.from(doc.querySelectorAll(target));
			} catch {
				return `${target} is not a valid CSS selector or ref.`;
			}
		}
		if (matches.length === 0) return `No element matches ${target}.`;
		if (matches.length > 1)
			return `${target} matches ${matches.length} elements; use a ref from snapshot or a narrower selector.`;
		return matches[0] as Element;
	};

	const centerOf = (el: Element): Point => {
		(el as HTMLElement).scrollIntoView?.({ block: "center", inline: "center" });
		const box = el.getBoundingClientRect();
		return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
	};

	const send = (el: Element, type: string, at: Point, init: Record<string, unknown> = {}): boolean => {
		const base = { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, view: win, ...init };
		const PointerCtor = type.startsWith("pointer") ? g.PointerEvent : undefined;
		const Ctor = PointerCtor ?? g.MouseEvent;
		return el.dispatchEvent(new Ctor(type, PointerCtor ? { pointerType: "mouse", isPrimary: true, ...base } : base));
	};

	const enter = (el: Element, at: Point): void => {
		const quiet = { bubbles: false, cancelable: false };
		send(el, "pointerover", at);
		send(el, "pointerenter", at, quiet);
		send(el, "mouseover", at);
		send(el, "mouseenter", at, quiet);
		send(el, "pointermove", at);
		send(el, "mousemove", at);
	};

	const press = (el: Element, at: Point, button: keyof typeof BUTTONS, detail = 1): void => {
		send(el, "pointerdown", at, { button: BUTTONS[button], buttons: MASKS[button], detail });
		send(el, "mousedown", at, { button: BUTTONS[button], buttons: MASKS[button], detail });
	};

	const release = (el: Element, at: Point, button: keyof typeof BUTTONS, detail = 1): void => {
		send(el, "pointerup", at, { button: BUTTONS[button], buttons: 0, detail });
		send(el, "mouseup", at, { button: BUTTONS[button], buttons: 0, detail });
	};

	const label = (el: Element): string => `<${el.tagName.toLowerCase()}>`;
	const remember = (at: Point): void => void (win[POINTER] = at);
	const pointed = (): { el: Element; at: Point } | string => {
		const at = win[POINTER] as Point | undefined;
		if (!at) return "The pointer has no position yet. Run pw --ext hover or mousemove first.";
		return { el: doc.elementFromPoint(at.x, at.y) ?? doc.body, at };
	};

	if (doc.URL !== expectUrl) return { error: "The page changed; nothing was done. Retry." };

	switch (action.kind) {
		case "hover": {
			const el = resolve(action.target);
			if (typeof el === "string") return { error: el };
			const at = centerOf(el);
			enter(el, at);
			remember(at);
			return { detail: `hovered ${label(el)}` };
		}
		case "dblclick": {
			const el = resolve(action.target);
			if (typeof el === "string") return { error: el };
			if ((el as HTMLButtonElement).disabled) return { error: `${label(el)} is disabled.` };
			const at = centerOf(el);
			enter(el, at);
			for (const detail of [1, 2]) {
				press(el, at, "left", detail);
				release(el, at, "left", detail);
				send(el, "click", at, { button: 0, detail });
			}
			send(el, "dblclick", at, { button: 0, detail: 2 });
			remember(at);
			return { detail: `double-clicked ${label(el)}` };
		}
		case "drag": {
			const from = resolve(action.target);
			if (typeof from === "string") return { error: from };
			const to = resolve(action.to);
			if (typeof to === "string") return { error: to };
			const start = centerOf(from);
			const end = centerOf(to);
			enter(from, start);
			press(from, start, "left");
			const DragCtor = g.DragEvent ?? g.MouseEvent;
			const drag = (el: Element, type: string, at: Point) =>
				el.dispatchEvent(new DragCtor(type, { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
			drag(from, "dragstart", start);
			enter(to, end);
			drag(to, "dragenter", end);
			drag(to, "dragover", end);
			drag(to, "drop", end);
			drag(from, "dragend", end);
			release(to, end, "left");
			remember(end);
			return { detail: `dragged ${label(from)} onto ${label(to)}` };
		}
		case "mousemove": {
			const at = { x: action.x, y: action.y };
			const el = doc.elementFromPoint(at.x, at.y) ?? doc.body;
			enter(el, at);
			remember(at);
			return { detail: `moved the pointer to ${action.x}, ${action.y} over ${label(el)}` };
		}
		case "mousedown":
		case "mouseup": {
			const found = pointed();
			if (typeof found === "string") return { error: found };
			(action.kind === "mousedown" ? press : release)(found.el, found.at, action.button);
			return { detail: `${action.kind === "mousedown" ? "pressed" : "released"} the ${action.button} button over ${label(found.el)}` };
		}
		case "mousewheel": {
			const found = pointed();
			if (typeof found === "string") return { error: found };
			const free = found.el.dispatchEvent(
				new g.WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					clientX: found.at.x,
					clientY: found.at.y,
					deltaX: action.dx,
					deltaY: action.dy,
				}),
			);
			if (free) win.scrollBy(action.dx, action.dy);
			return { detail: `scrolled the wheel by ${action.dx}, ${action.dy} over ${label(found.el)}` };
		}
	}
}

function actionOf(request: PointerRequest): PointerAction {
	switch (request.verb) {
		case "hover":
		case "dblclick":
			return { kind: request.verb, target: request.target };
		case "drag":
			return { kind: "drag", target: request.target, to: request.to };
		case "mousemove":
			return { kind: "mousemove", x: request.x, y: request.y };
		case "mousedown":
		case "mouseup":
			return { kind: request.verb, button: request.button ?? "left" };
		case "mousewheel":
			return { kind: "mousewheel", dx: request.dx, dy: request.dy };
	}
}

/** Runs one pointer verb against the agent's own tab group; any tab outside it is refused. */
export function createPointerHandler({
	browserApi: api,
	agentTabs,
}: {
	browserApi: PointerBrowserApi;
	agentTabs: Pick<AgentTabs, "owns" | "selected">;
}) {
	return async function handlePointer(request: PointerRequest, context: { sessionId: string }): Promise<Result> {
		const { sessionId } = context;
		const tabId = request.tabId ?? (await agentTabs.selected({ sessionId }))?.tabId;
		if (tabId === undefined) return { ok: false, error: NO_TAB };
		if (!(await agentTabs.owns({ sessionId, tabId }))) return { ok: false, error: notInGroup(tabId) };
		const tab = await api.tabs.get(tabId).catch(() => undefined);
		if (!tab) return { ok: false, error: notInGroup(tabId) };
		if (tab.incognito) return { ok: false, error: PW_EXT_PRIVATE_ERROR };
		if (!allowedPage(tab.url)) return { ok: false, error: PW_EXT_BLOCKED_ERROR };
		if (mailbox(tab.url)) return { ok: false, error: PW_EXT_MAILBOX_ERROR };
		if (tab.discarded)
			return { ok: false, error: `This agent's tab was discarded by the browser. Run pw --ext select ${tabId} again after it reloads.` };
		const [frame] = await api.scripting.executeScript({
			target: { tabId },
			func: pwExtPointerAction,
			args: [actionOf(request), tab.url],
		});
		const result = frame?.result as PointerResult | undefined;
		if (!result) return { ok: false, error: "The page returned an unexpected result." };
		if ("error" in result) return { ok: false, error: result.error };
		return { ok: true, data: { text: ["### Result", result.detail].join("\n") } };
	};
}

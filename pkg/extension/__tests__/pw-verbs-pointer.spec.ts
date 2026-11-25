import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import type { PointerRequest } from "../../common/src/pw-ext-verbs/pointer";
import { createAgentTabs } from "@/lib/background/agent-tabs";
import { createPointerHandler, pwExtPointerAction } from "@/lib/background/pw-verbs/pointer";
import { createFakeBrowser, createLock, recordOf, tabOf, windowOf } from "./utils/fake-browser";

const SESSION = "session-1";
const WINDOW = 3;
const GROUP = 10;
const URL_OK = "https://app.example.test/home";

function harness(tabs = [tabOf({ id: 7, windowId: WINDOW, groupId: GROUP, url: URL_OK })]) {
	const fake = createFakeBrowser({
		windows: [windowOf({ id: WINDOW })],
		lastFocusedWindowId: WINDOW,
		tabs: [...tabs, tabOf({ id: 21, windowId: WINDOW, url: URL_OK }), tabOf({ id: 20, windowId: WINDOW, groupId: 11, url: URL_OK })],
		groups: [
			{ id: GROUP, windowId: WINDOW, title: "agent" },
			{ id: 11, windowId: WINDOW, title: "theirs" },
		],
	});
	fake.seedRecord(recordOf({ sessionId: SESSION, groupId: GROUP, selectedTabId: 7 }));
	const runs: { tabId: number; args: unknown[] }[] = [];
	fake.state.script = (details) => {
		const call = details as { target: { tabId: number }; args: unknown[] };
		runs.push({ tabId: call.target.tabId, args: call.args });
		return { detail: "hovered <a>" };
	};
	const agentTabs = createAgentTabs({ browserApi: fake.api, storage: fake.api.storage, lock: createLock() });
	const handle = createPointerHandler({ browserApi: fake.api as never, agentTabs });
	return { handle, runs };
}

describe("createPointerHandler", () => {
	it("runs on the selected tab and returns the page detail", async () => {
		const { handle, runs } = harness();
		const result = await handle({ verb: "hover", target: "e1" }, { sessionId: SESSION });
		expect(result).toEqual({ ok: true, data: { text: "### Result\nhovered <a>" } });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.tabId).toBe(7);
		expect(runs[0]?.args).toEqual([{ kind: "hover", target: "e1" }, URL_OK]);
	});

	it.each<PointerRequest>([
		{ verb: "hover", tabId: 21, target: "e1" },
		{ verb: "dblclick", tabId: 20, target: "e1" },
		{ verb: "drag", tabId: 21, target: "e1", to: "e2" },
		{ verb: "mousedown", tabId: 21 },
		{ verb: "mouseup", tabId: 20 },
		{ verb: "mousemove", tabId: 21, x: 1, y: 1 },
		{ verb: "mousewheel", tabId: 20, dx: 0, dy: 10 },
	])("refuses a tab outside the agent group for $verb", async (request) => {
		const { handle, runs } = harness();
		const result = await handle(request, { sessionId: SESSION });
		expect(result).toEqual({
			ok: false,
			error: `pw --ext: tab ${request.tabId} is not in this agent's tab group; run pw --ext tabs to list them.`,
		});
		expect(runs).toHaveLength(0);
	});

	it("refuses a tab of another session", async () => {
		const { handle, runs } = harness();
		const result = await handle({ verb: "hover", target: "e1" }, { sessionId: "unknown-session" });
		expect(result.ok).toBe(false);
		expect(runs).toHaveLength(0);
	});

	it("refuses a browser page and a private tab", async () => {
		const page = harness([tabOf({ id: 7, windowId: WINDOW, groupId: GROUP, url: "chrome://settings/" })]);
		expect((await page.handle({ verb: "hover", target: "e1" }, { sessionId: SESSION })).ok).toBe(false);
		expect(page.runs).toHaveLength(0);
		const priv = harness([tabOf({ id: 7, windowId: WINDOW, groupId: GROUP, url: URL_OK, incognito: true })]);
		expect((await priv.handle({ verb: "hover", target: "e1" }, { sessionId: SESSION })).ok).toBe(false);
		expect(priv.runs).toHaveLength(0);
	});

	it("passes the default left button and the page error through", async () => {
		const { handle, runs } = harness();
		await handle({ verb: "mousedown" }, { sessionId: SESSION });
		expect(runs[0]?.args[0]).toEqual({ kind: "mousedown", button: "left" });
	});
});

describe("pwExtPointerAction", () => {
	let window: Window;
	const original = Object.getOwnPropertyDescriptor(globalThis, "document");

	beforeEach(() => {
		window = new Window({ url: URL_OK });
		Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
		window.document.body.innerHTML = `<button id="a">A</button><div id="b">B</div><div id="c">C</div><div id="c2">C2</div>`;
	});

	afterEach(async () => {
		if (original) Object.defineProperty(globalThis, "document", original);
		else delete (globalThis as { document?: unknown }).document;
		await window.happyDOM.close();
	});

	function record(selector: string, types: string[]): string[] {
		const seen: string[] = [];
		const el = window.document.querySelector(selector) as unknown as HTMLElement;
		for (const type of types) el.addEventListener(type, () => void seen.push(type));
		return seen;
	}

	it("hover fires pointer and mouse move events on the target", () => {
		const seen = record("#a", ["mouseover", "mousemove", "click"]);
		expect(pwExtPointerAction({ kind: "hover", target: "#a" }, URL_OK)).toEqual({ detail: "hovered <button>" });
		expect(seen).toEqual(["mouseover", "mousemove"]);
	});

	it("dblclick fires two clicks then dblclick", () => {
		const seen = record("#a", ["click", "dblclick"]);
		pwExtPointerAction({ kind: "dblclick", target: "#a" }, URL_OK);
		expect(seen).toEqual(["click", "click", "dblclick"]);
	});

	it("drag presses the source and releases on the destination", () => {
		const source = record("#b", ["mousedown", "dragstart"]);
		const dest = record("#c", ["dragover", "drop", "mouseup"]);
		expect(pwExtPointerAction({ kind: "drag", target: "#b", to: "#c" }, URL_OK)).toEqual({
			detail: "dragged <div> onto <div>",
		});
		expect(source).toEqual(["mousedown", "dragstart"]);
		expect(dest).toEqual(["dragover", "drop", "mouseup"]);
	});

	it("mousedown and mouseup refuse before the pointer has a position", () => {
		expect(pwExtPointerAction({ kind: "mousedown", button: "left" }, URL_OK)).toEqual({
			error: "The pointer has no position yet. Run pw --ext hover or mousemove first.",
		});
	});

	it("mousedown and mouseup act at the position a hover left", () => {
		const seen = record("#a", ["mousedown", "mouseup"]);
		(window.document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () =>
			window.document.querySelector("#a") as unknown as Element;
		pwExtPointerAction({ kind: "hover", target: "#a" }, URL_OK);
		pwExtPointerAction({ kind: "mousedown", button: "right" }, URL_OK);
		pwExtPointerAction({ kind: "mouseup", button: "right" }, URL_OK);
		expect(seen).toEqual(["mousedown", "mouseup"]);
	});

	it("mousemove and mousewheel reach the element under the point", () => {
		const seen = record("#a", ["mousemove", "wheel"]);
		(window.document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () =>
			window.document.querySelector("#a") as unknown as Element;
		pwExtPointerAction({ kind: "mousemove", x: 5, y: 6 }, URL_OK);
		const wheel = pwExtPointerAction({ kind: "mousewheel", dx: 0, dy: 40 }, URL_OK);
		expect(seen).toEqual(["mousemove", "wheel"]);
		expect(wheel).toEqual({ detail: "scrolled the wheel by 0, 40 over <button>" });
	});

	it("reports a missing and an ambiguous target", () => {
		expect(pwExtPointerAction({ kind: "hover", target: "#nope" }, URL_OK)).toEqual({ error: "No element matches #nope." });
		expect(pwExtPointerAction({ kind: "hover", target: "div" }, URL_OK)).toEqual({
			error: "div matches 3 elements; use a ref from snapshot or a narrower selector.",
		});
		expect(pwExtPointerAction({ kind: "hover", target: "e9" }, URL_OK)).toEqual({
			error: "Ref e9 not found. Run dg pw --ext snapshot again.",
		});
	});

	it("does nothing when the page address changed", () => {
		const seen = record("#a", ["mouseover"]);
		expect(pwExtPointerAction({ kind: "hover", target: "#a" }, "https://other.example.test/")).toEqual({
			error: "The page changed; nothing was done. Retry.",
		});
		expect(seen).toEqual([]);
	});
});

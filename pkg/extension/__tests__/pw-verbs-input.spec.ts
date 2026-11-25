import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { createInputHandler, pwExtInputAction } from "@/lib/background/pw-verbs/input";

const SESSION = { sessionId: "session-1" };
const GROUP = 10;

type Tab = { id: number; groupId: number; url: string; incognito?: boolean; discarded?: boolean };

function harness(options: { tabs?: Tab[]; selected?: number; result?: unknown } = {}) {
	const tabs = new Map((options.tabs ?? [{ id: 7, groupId: GROUP, url: "https://app.example.test/home" }]).map((tab) => [tab.id, tab]));
	const scripts: { tabId: number; args: unknown[] }[] = [];
	const handler = createInputHandler({
		agentTabs: {
			owns: async ({ tabId }) => tabs.get(tabId)?.groupId === GROUP,
			selected: async () => (options.selected === undefined ? undefined : { tabId: options.selected }),
		},
		browserApi: {
			tabs: {
				get: async (tabId) => {
					const tab = tabs.get(tabId);
					if (!tab) throw new Error("No tab");
					return tab;
				},
			},
			scripting: {
				executeScript: async ({ target, args }) => {
					scripts.push({ tabId: target.tabId, args });
					return [{ result: options.result ?? { detail: "done" } }];
				},
			},
		},
	});
	return { handler, scripts };
}

const OUTSIDE: Tab = { id: 21, groupId: -1, url: "https://user.example.test/" };
const REQUESTS = [
	{ verb: "check", target: "e1" },
	{ verb: "uncheck", target: "e1" },
	{ verb: "type", text: "hi" },
	{ verb: "keydown", key: "Shift" },
	{ verb: "keyup", key: "Shift" },
] as const;

describe("input handler", () => {
	it.each(REQUESTS)("refuses a tab outside the agent tab group for $verb", async (request) => {
		const { handler, scripts } = harness({ tabs: [OUTSIDE] });
		const result = await handler({ ...request, tabId: 21 }, SESSION);
		expect(result).toEqual({
			ok: false,
			error: "pw --ext: tab 21 is not in this agent's tab group; run pw --ext tabs to list them.",
		});
		expect(scripts).toEqual([]);
	});

	it("refuses when the agent has no selected tab", async () => {
		const { handler, scripts } = harness();
		expect(await handler({ verb: "check", target: "e1" }, SESSION)).toEqual({
			ok: false,
			error: "This agent has no tab yet. Run pw --ext new <url> first.",
		});
		expect(scripts).toEqual([]);
	});

	it("runs on the selected tab and returns the page detail", async () => {
		const { handler, scripts } = harness({ selected: 7, result: { detail: "checked checkbox \"Agree\"" } });
		const result = await handler({ verb: "check", target: "e1" }, SESSION);
		expect(result).toEqual({ ok: true, data: { text: "### Result\nchecked checkbox \"Agree\"" } });
		expect(scripts).toHaveLength(1);
		expect(scripts[0]?.tabId).toBe(7);
		expect(scripts[0]?.args[0]).toEqual({ kind: "check", target: "e1" });
		expect(scripts[0]?.args[1]).toBe("https://app.example.test/home");
	});

	it("passes the key and the submit flag to the page", async () => {
		const { handler, scripts } = harness({ selected: 7 });
		await handler({ verb: "keydown", key: "Shift" }, SESSION);
		await handler({ verb: "type", text: "hi", submit: true }, SESSION);
		expect(scripts.map((script) => script.args[0])).toEqual([
			{ kind: "keydown", key: "Shift" },
			{ kind: "type", text: "hi", submit: true },
		]);
	});

	it("returns the page error as a failure", async () => {
		const { handler } = harness({ selected: 7, result: { error: "No element matches #x." } });
		expect(await handler({ verb: "check", target: "#x" }, SESSION)).toEqual({ ok: false, error: "No element matches #x." });
	});

	it("never echoes typed text", async () => {
		const { handler } = harness({ selected: 7, result: { detail: "typed 6 characters into textbox \"Name\"" } });
		const result = await handler({ verb: "type", text: "secret" }, SESSION);
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it.each([
		[{ id: 7, groupId: GROUP, url: "https://app.example.test/", incognito: true }, "private window"],
		[{ id: 7, groupId: GROUP, url: "chrome://settings" }, "non-web pages"],
		[{ id: 7, groupId: GROUP, url: "https://app.example.test/", discarded: true }, "discarded"],
	])("refuses a guarded tab %#", async (tab, message) => {
		const { handler, scripts } = harness({ tabs: [tab], selected: 7 });
		const result = await handler({ verb: "check", target: "e1" }, SESSION);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain(message);
		expect(scripts).toEqual([]);
	});

	it.each([[{ verb: "click", target: "e1" }], [{ verb: "check" }], [null]])("rejects the malformed request %j", async (raw) => {
		const { handler, scripts } = harness({ selected: 7 });
		expect(await handler(raw, SESSION)).toEqual({ ok: false, error: "Unsupported pw --ext request." });
		expect(scripts).toEqual([]);
	});

	it("reports an unexpected page result", async () => {
		const handler = createInputHandler({
			agentTabs: { owns: async () => true, selected: async () => ({ tabId: 7 }) },
			browserApi: {
				tabs: { get: async () => ({ id: 7, groupId: GROUP, url: "https://app.example.test/" }) },
				scripting: { executeScript: async () => [{}] },
			},
		});
		expect(await handler({ verb: "check", target: "e1" }, SESSION)).toEqual({
			ok: false,
			error: "The page returned an unexpected result.",
		});
	});
});

let window: Window;
const original = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
	window = new Window({ url: "https://app.example.test/home" });
	Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
});

afterEach(async () => {
	if (original) Object.defineProperty(globalThis, "document", original);
	else delete (globalThis as { document?: unknown }).document;
	await window.happyDOM.close();
});

function page(html: string): void {
	window.document.body.innerHTML = html;
}

function el<T>(selector: string): T {
	return window.document.querySelector(selector) as unknown as T;
}

const URL_OK = "https://app.example.test/home";

describe("check and uncheck in the page", () => {
	it("checks an unchecked checkbox and fires change", () => {
		page(`<input type="checkbox" id="a" aria-label="Agree">`);
		const events: string[] = [];
		el<HTMLInputElement>("#a").addEventListener("change", () => events.push("change"));
		expect(pwExtInputAction({ kind: "check", target: "#a" }, URL_OK)).toEqual({ detail: 'checked checkbox "Agree"' });
		expect(el<HTMLInputElement>("#a").checked).toBe(true);
		expect(events).toEqual(["change"]);
	});

	it("leaves a checked checkbox alone on check", () => {
		page(`<input type="checkbox" id="a" aria-label="Agree" checked>`);
		const events: string[] = [];
		el<HTMLInputElement>("#a").addEventListener("click", () => events.push("click"));
		expect(pwExtInputAction({ kind: "check", target: "#a" }, URL_OK)).toEqual({ detail: 'checkbox "Agree" was already checked' });
		expect(events).toEqual([]);
	});

	it("unchecks a checked checkbox", () => {
		page(`<input type="checkbox" id="a" aria-label="Agree" checked>`);
		expect(pwExtInputAction({ kind: "uncheck", target: "#a" }, URL_OK)).toEqual({ detail: 'unchecked checkbox "Agree"' });
		expect(el<HTMLInputElement>("#a").checked).toBe(false);
	});

	it("checks a radio button but cannot uncheck one", () => {
		page(`<input type="radio" id="r" name="g" aria-label="Pick">`);
		expect(pwExtInputAction({ kind: "check", target: "#r" }, URL_OK)).toEqual({ detail: 'checked radio "Pick"' });
		expect(pwExtInputAction({ kind: "uncheck", target: "#r" }, URL_OK)).toEqual({
			error: 'radio "Pick" is a radio button; a radio button cannot be unchecked.',
		});
		expect(el<HTMLInputElement>("#r").checked).toBe(true);
	});

	it("refuses a disabled checkbox", () => {
		page(`<input type="checkbox" id="a" aria-label="Agree" disabled>`);
		expect(pwExtInputAction({ kind: "check", target: "#a" }, URL_OK)).toEqual({ error: 'checkbox "Agree" is disabled.' });
	});

	it("refuses an element that is not a checkbox or radio", () => {
		page(`<button id="b">Go</button>`);
		expect(pwExtInputAction({ kind: "check", target: "#b" }, URL_OK)).toEqual({
			error: 'button "Go" is not a checkbox or radio button.',
		});
	});

	it("reports no match, many matches, a bad selector and a stale ref", () => {
		page(`<input type="checkbox"><input type="checkbox">`);
		expect(pwExtInputAction({ kind: "check", target: "#none" }, URL_OK)).toEqual({ error: "No element matches #none." });
		expect(pwExtInputAction({ kind: "check", target: "input" }, URL_OK)).toEqual({
			error: "input matches 2 elements; use a ref from snapshot or a narrower selector.",
		});
		expect(pwExtInputAction({ kind: "check", target: "[[" }, URL_OK)).toEqual({ error: "[[ is not a valid CSS selector or ref." });
		expect(pwExtInputAction({ kind: "check", target: "e9" }, URL_OK)).toEqual({
			error: "Ref e9 not found. Run dg pw --ext snapshot again.",
		});
	});

	it("reports a page that blocks the change", () => {
		page(`<input type="checkbox" id="a" aria-label="Agree">`);
		el<HTMLInputElement>("#a").addEventListener("click", (event) => event.preventDefault());
		expect(pwExtInputAction({ kind: "check", target: "#a" }, URL_OK)).toEqual({
			error: 'checkbox "Agree" did not change state; the page blocked it.',
		});
	});

	it("does nothing when the page moved", () => {
		page(`<input type="checkbox" id="a">`);
		expect(pwExtInputAction({ kind: "check", target: "#a" }, "https://elsewhere.example.test/")).toEqual({
			error: "The page changed; nothing was done. Retry.",
		});
		expect(el<HTMLInputElement>("#a").checked).toBe(false);
	});
});

describe("type in the page", () => {
	it("types into the focused text field and reports only the count", () => {
		page(`<label>Name <input id="n"></label>`);
		const field = el<HTMLInputElement>("#n");
		field.focus();
		const events: string[] = [];
		field.addEventListener("input", () => events.push("input"));
		expect(pwExtInputAction({ kind: "type", text: "Ada" }, URL_OK)).toEqual({ detail: 'typed 3 characters into textbox "Name"' });
		expect(field.value).toBe("Ada");
		expect(events).toEqual(["input", "input", "input"]);
	});

	it("inserts at the caret instead of replacing the value", () => {
		page(`<input id="n" value="ac">`);
		const field = el<HTMLInputElement>("#n");
		field.focus();
		field.setSelectionRange(1, 1);
		pwExtInputAction({ kind: "type", text: "b" }, URL_OK);
		expect(field.value).toBe("abc");
	});

	it("types into a textarea", () => {
		page(`<textarea id="t"></textarea>`);
		el<HTMLTextAreaElement>("#t").focus();
		pwExtInputAction({ kind: "type", text: "line" }, URL_OK);
		expect(el<HTMLTextAreaElement>("#t").value).toBe("line");
	});

	it("refuses a password field", () => {
		page(`<input id="p" type="password">`);
		el<HTMLInputElement>("#p").focus();
		const result = pwExtInputAction({ kind: "type", text: "hunter2-secret" }, URL_OK);
		expect(result).toEqual({ error: "pw --ext type never types into a secret field. Use fill with --value-env or --value-stdin." });
		expect(el<HTMLInputElement>("#p").value).toBe("");
	});

	it("refuses a field named like a secret", () => {
		page(`<input id="p" name="api_token">`);
		el<HTMLInputElement>("#p").focus();
		expect(pwExtInputAction({ kind: "type", text: "abc" }, URL_OK)).toHaveProperty("error");
		expect(el<HTMLInputElement>("#p").value).toBe("");
	});

	it("refuses when nothing editable has focus", () => {
		page(`<button id="b">Go</button>`);
		el<HTMLButtonElement>("#b").focus();
		expect(pwExtInputAction({ kind: "type", text: "x" }, URL_OK)).toEqual({
			error: "No text field has focus. Click or fill one first.",
		});
	});

	it("refuses a read-only field", () => {
		page(`<input id="n" readonly>`);
		el<HTMLInputElement>("#n").focus();
		expect(pwExtInputAction({ kind: "type", text: "x" }, URL_OK)).toEqual({ error: 'textbox is read-only or disabled.' });
	});

	it("submits the form after typing when asked", () => {
		page(`<form id="f"><input id="n"><button type="submit">Send</button></form>`);
		el<HTMLInputElement>("#n").focus();
		let submitted = 0;
		el<HTMLFormElement>("#f").addEventListener("submit", (event) => {
			event.preventDefault();
			submitted++;
		});
		const result = pwExtInputAction({ kind: "type", text: "x", submit: true }, URL_OK);
		expect(result).toEqual({ detail: "typed 1 character into textbox; submitted the form" });
		expect(submitted).toBe(1);
	});
});

describe("keydown and keyup in the page", () => {
	it("dispatches keydown on the focused element with the modifier flag", () => {
		page(`<input id="n">`);
		const field = el<HTMLInputElement>("#n");
		field.focus();
		const seen: { key: string; shift: boolean; type: string }[] = [];
		for (const type of ["keydown", "keyup"])
			field.addEventListener(type, (event) => {
				const key = event as unknown as KeyboardEvent;
				seen.push({ key: key.key, shift: key.shiftKey, type: key.type });
			});
		expect(pwExtInputAction({ kind: "keydown", key: "Shift" }, URL_OK)).toEqual({ detail: "pressed Shift down on textbox" });
		expect(pwExtInputAction({ kind: "keyup", key: "Shift" }, URL_OK)).toEqual({ detail: "released Shift on textbox" });
		expect(seen).toEqual([
			{ key: "Shift", shift: true, type: "keydown" },
			{ key: "Shift", shift: false, type: "keyup" },
		]);
	});

	it("dispatches on the page when nothing has focus", () => {
		page(`<p>text</p>`);
		let key = "";
		window.document.body.addEventListener("keydown", (event) => {
			key = (event as unknown as KeyboardEvent).key;
		});
		expect(pwExtInputAction({ kind: "keydown", key: "Escape" }, URL_OK)).toEqual({ detail: "pressed Escape down on the page" });
		expect(key).toBe("Escape");
	});

	it("maps Space to a space key", () => {
		page(`<p>text</p>`);
		let key = "";
		window.document.body.addEventListener("keydown", (event) => {
			key = (event as unknown as KeyboardEvent).key;
		});
		pwExtInputAction({ kind: "keydown", key: "Space" }, URL_OK);
		expect(key).toBe(" ");
	});

	it("does nothing when the page moved", () => {
		page(`<p>text</p>`);
		expect(pwExtInputAction({ kind: "keydown", key: "a" }, "https://elsewhere.example.test/")).toEqual({
			error: "The page changed; nothing was done. Retry.",
		});
	});
});

import { type InputRequest, type InputResult, validate } from "@dg/common/pw-ext-verbs/input";
import type { BrowserTab } from "@/lib/background/agent-tabs";
import { guardedTab } from "@/lib/background/tab-guards";

export type InputPageAction =
	| { kind: "check" | "uncheck"; target: string }
	| { kind: "type"; text: string; submit?: true }
	| { kind: "keydown" | "keyup"; key: string };

type InputPageResult = { detail: string } | { error: string };

export type InputDeps = {
	agentTabs: {
		owns(agent: { sessionId: string; tabId: number }): Promise<boolean>;
		selected(agent: { sessionId: string }): Promise<{ tabId: number } | undefined>;
	};
	browserApi: {
		tabs: { get(tabId: number): Promise<BrowserTab> };
		scripting: {
			executeScript(injection: {
				target: { tabId: number };
				func: typeof pwExtInputAction;
				args: [InputPageAction, string];
			}): Promise<{ result?: unknown }[]>;
		};
	};
};

function pageAction(request: InputRequest): InputPageAction {
	switch (request.verb) {
		case "check":
		case "uncheck":
			return { kind: request.verb, target: request.target };
		case "type":
			return { kind: "type", text: request.text, ...(request.submit ? { submit: true as const } : {}) };
		case "keydown":
		case "keyup":
			return { kind: request.verb, key: request.key };
	}
}

function isPageResult(value: unknown): value is InputPageResult {
	if (typeof value !== "object" || value === null) return false;
	const { detail, error } = value as { detail?: unknown; error?: unknown };
	return typeof detail === "string" || typeof error === "string";
}

/** Handles check, uncheck, type, keydown and keyup on one tab of the caller's agent tab group. */
export function createInputHandler({ agentTabs, browserApi }: InputDeps) {
	return async function handleInput(raw: unknown, { sessionId }: { sessionId: string }): Promise<InputResult> {
		let request: InputRequest;
		try {
			request = validate(raw);
		} catch {
			return { ok: false, error: "Unsupported pw --ext request." };
		}
		const found = await guardedTab({ agentTabs, tabs: browserApi.tabs, sessionId, requested: request.tabId });
		if (!found.ok) return { ok: false, error: found.error };
		const { tabId, tab } = found;
		const [frame] = await browserApi.scripting.executeScript({
			target: { tabId },
			func: pwExtInputAction,
			args: [pageAction(request), tab.url],
		});
		const result = frame?.result;
		if (!isPageResult(result)) return { ok: false, error: "The page returned an unexpected result." };
		return "error" in result
			? { ok: false, error: result.error }
			: { ok: true, data: { text: `### Result\n${result.detail}` } };
	};
}

/** Self-contained action that scripting.executeScript runs in the tab's isolated world. */
export function pwExtInputAction(action: InputPageAction, expectUrl: string): InputPageResult {
	const doc = document;
	const win = doc.defaultView as unknown as typeof globalThis & Record<symbol, unknown>;
	const REFS = Symbol.for("dg.pwExt.refs");
	const SECRET_NAME = /pass|secret|token|otp|cvv|cvc|ssn|pin\b|api[-_]?key/i;
	const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "tel", "number"]);
	const MODIFIER_FLAGS: Record<string, string> = {
		Shift: "shiftKey",
		Control: "ctrlKey",
		Alt: "altKey",
		Meta: "metaKey",
	};
	const NAME_MAX = 80;

	const typeOf = (el: Element): string => (el.tagName === "INPUT" ? (el as HTMLInputElement).type.toLowerCase() : "");

	const role = (el: Element): string => {
		const type = typeOf(el);
		if (type === "checkbox" || type === "radio") return type;
		if (el.tagName === "BUTTON" || ["button", "submit", "reset", "image"].includes(type)) return "button";
		if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return "textbox";
		return el.tagName.toLowerCase();
	};

	const nameOf = (el: Element): string => {
		const direct = el.getAttribute("aria-label");
		const label = Array.from(doc.querySelectorAll("label")).find(
			(candidate) => candidate.contains(el) || (el.id !== "" && candidate.htmlFor === el.id),
		);
		const text = direct ?? label?.textContent ?? (el.tagName === "BUTTON" ? el.textContent : "") ?? "";
		return text.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
	};

	const describe = (el: Element): string => {
		const name = nameOf(el);
		return name ? `${role(el)} "${name}"` : role(el);
	};

	const candidates = (target: string): Element[] | string => {
		if (/^e\d+$/.test(target)) {
			const found = (win[REFS] as Map<string, Element> | undefined)?.get(target);
			if (!found || !found.isConnected) return `Ref ${target} not found. Run dg pw --ext snapshot again.`;
			return [found];
		}
		try {
			return Array.from(doc.querySelectorAll(target));
		} catch {
			return `${target} is not a valid CSS selector or ref.`;
		}
	};

	const resolve = (target: string): Element | string => {
		const matches = candidates(target);
		if (typeof matches === "string") return matches;
		if (matches.length === 0) return `No element matches ${target}.`;
		if (matches.length > 1)
			return `${target} matches ${matches.length} elements; use a ref from snapshot or a narrower selector.`;
		return matches[0] as Element;
	};

	const setChecked = (target: string, wanted: boolean): InputPageResult => {
		const el = resolve(target);
		if (typeof el === "string") return { error: el };
		const type = typeOf(el);
		if (type !== "checkbox" && type !== "radio") return { error: `${describe(el)} is not a checkbox or radio button.` };
		const input = el as HTMLInputElement;
		if (input.disabled) return { error: `${describe(el)} is disabled.` };
		if (type === "radio" && !wanted) return { error: `${describe(el)} is a radio button; a radio button cannot be unchecked.` };
		if (input.checked === wanted) return { detail: `${describe(el)} was already ${wanted ? "checked" : "unchecked"}` };
		input.scrollIntoView?.({ block: "center" });
		input.click();
		if (input.checked !== wanted) return { error: `${describe(el)} did not change state; the page blocked it.` };
		return { detail: `${wanted ? "checked" : "unchecked"} ${describe(el)}` };
	};

	const keyInit = (key: string, down: boolean) => {
		const flag = MODIFIER_FLAGS[key];
		return {
			key,
			code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === " " ? "Space" : key,
			bubbles: true,
			cancelable: true,
			composed: true,
			...(flag && down ? { [flag]: true } : {}),
		};
	};

	const secretField = (el: Element): boolean =>
		typeOf(el) === "password" ||
		SECRET_NAME.test(`${el.getAttribute("name") ?? ""} ${el.id} ${el.getAttribute("autocomplete") ?? ""}`);

	const setValue = (el: Element, value: string): void => {
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set?.call(el, value);
	};

	const insert = (field: HTMLInputElement | HTMLTextAreaElement, char: string): void => {
		const value = field.value;
		const start = field.selectionStart ?? value.length;
		const end = field.selectionEnd ?? value.length;
		setValue(field, value.slice(0, start) + char + value.slice(end));
		try {
			field.setSelectionRange(start + char.length, start + char.length);
		} catch {}
		field.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: char }));
	};

	const typeText = (text: string, submit: boolean): InputPageResult => {
		const active = doc.activeElement;
		const typable =
			active !== null &&
			(active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && (TEXT_INPUTS.has(typeOf(active)) || typeOf(active) === "password")));
		if (!typable) return { error: "No text field has focus. Click or fill one first." };
		const field = active as HTMLInputElement | HTMLTextAreaElement;
		if (secretField(field))
			return { error: "pw --ext type never types into a secret field. Use fill with --value-env or --value-stdin." };
		if (field.disabled || field.readOnly) return { error: `${describe(field)} is read-only or disabled.` };
		const chars = Array.from(text);
		let typed = 0;
		for (const char of chars) {
			const send = (kind: string): boolean => field.dispatchEvent(new win.KeyboardEvent(kind, keyInit(char, true)));
			if (!send("keydown") || !field.isConnected) break;
			insert(field, char);
			send("keyup");
			typed++;
		}
		if (typed < chars.length)
			return { error: `Typed only ${typed} of ${chars.length} characters into ${describe(field)}; the page blocked the rest.` };
		const form = (field as HTMLInputElement).form;
		const suffix = submit && form ? (form.requestSubmit(), "; submitted the form") : "";
		return { detail: `typed ${typed} character${typed === 1 ? "" : "s"} into ${describe(field)}${suffix}` };
	};

	const pressKey = (key: string, down: boolean): InputPageResult => {
		const active = doc.activeElement;
		const target = active && active !== doc.body ? active : (doc.body ?? doc.documentElement);
		const label = target === doc.body || target === doc.documentElement ? "the page" : describe(target);
		const name = key === "Space" ? " " : key;
		target.dispatchEvent(new win.KeyboardEvent(down ? "keydown" : "keyup", keyInit(name, down)));
		return { detail: down ? `pressed ${key} down on ${label}` : `released ${key} on ${label}` };
	};

	if (doc.URL !== expectUrl) return { error: "The page changed; nothing was done. Retry." };
	switch (action.kind) {
		case "check":
			return setChecked(action.target, true);
		case "uncheck":
			return setChecked(action.target, false);
		case "type":
			return typeText(action.text, action.submit === true);
		case "keydown":
			return pressKey(action.key, true);
		case "keyup":
			return pressKey(action.key, false);
	}
}

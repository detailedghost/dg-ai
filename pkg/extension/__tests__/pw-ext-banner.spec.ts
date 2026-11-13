import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { bannerTitle, PW_EXT_STOP_MESSAGE, pwExtBanner } from "@/lib/features/pw-ext-banner";

let window: Window;
const saved = {
	document: Object.getOwnPropertyDescriptor(globalThis, "document"),
	chrome: Object.getOwnPropertyDescriptor(globalThis, "chrome"),
};
let sent: unknown[];

beforeEach(() => {
	window = new Window({ url: "https://app.example.test/" });
	sent = [];
	Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: { runtime: { sendMessage: async (message: unknown) => void sent.push(message) } },
	});
});

afterEach(async () => {
	for (const [key, descriptor] of Object.entries(saved))
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<string, unknown>)[key];
	await window.happyDOM.close();
});

const hosts = () => window.document.querySelectorAll("dg-agent-banner");

function captureShadow(): { root?: ShadowRoot } {
	const opened: { root?: ShadowRoot } = {};
	const attach = window.HTMLElement.prototype.attachShadow;
	window.HTMLElement.prototype.attachShadow = function (this: HTMLElement, init: ShadowRootInit) {
		opened.root = attach.call(this, init) as unknown as ShadowRoot;
		return opened.root as never;
	};
	return opened;
}

describe("banner title", () => {
	it("strips control and format characters, trims, and caps the length", () => {
		expect(bannerTitle({ title: "  claude\u0000-code\u202e · 3f9a\n", sessionId: "3f9a1234" })).toBe("claude-code · 3f9a");
		expect(bannerTitle({ title: "x".repeat(80), sessionId: "3f9a" })).toHaveLength(40);
	});

	it("falls back to the short session id when the title is empty", () => {
		expect(bannerTitle({ title: " \u200b ", sessionId: "3f9a1234" })).toBe("3f9a");
	});
});

describe("agent banner", () => {
	it("shows one banner with no page-readable text", () => {
		pwExtBanner(true);
		pwExtBanner(true);
		expect(hosts()).toHaveLength(1);
		const host = hosts()[0] as unknown as { shadowRoot: unknown; textContent: string };
		expect(host.shadowRoot).toBeNull();
		expect(host.textContent).toBe("");
	});

	it("keeps the banner host out of the page layout as a strip over the page top", () => {
		pwExtBanner(true);
		const host = hosts()[0] as unknown as HTMLElement;
		for (const [name, value] of [
			["position", "fixed"],
			["top", "0px"],
			["left", "0px"],
			["right", "0px"],
			["bottom", "auto"],
			["height", "auto"],
			["z-index", "2147483647"],
		]) {
			expect(host.style.getPropertyValue(name)).toBe(value);
			expect(host.style.getPropertyPriority(name)).toBe("important");
		}
	});

	it("shows the ghost as inline SVG, the agent text, and the group title in the shadow root", () => {
		const opened = captureShadow();
		pwExtBanner(true, "claude-code · 3f9a");
		const root = opened.root as ShadowRoot;
		expect(root.querySelector("svg")).not.toBeNull();
		expect(root.querySelector("img")).toBeNull();
		expect(root.querySelector("style")?.textContent).toContain("prefers-color-scheme: dark");
		expect(root.querySelector('[role="status"]')).not.toBeNull();
		expect(root.textContent).toContain("DeeGee");
		expect(root.textContent).toContain("Agent is driving this tab");
		expect(root.textContent).toContain("claude-code · 3f9a");
	});

	it("shows the new group title when the tab moves to another agent group", () => {
		const opened = captureShadow();
		pwExtBanner(true, "first · aaaa");
		pwExtBanner(true, "second · bbbb");
		expect(hosts()).toHaveLength(1);
		expect(opened.root?.textContent).toContain("second · bbbb");
		expect(opened.root?.textContent).not.toContain("first · aaaa");
	});

	it("renders the group title as text, never as HTML", () => {
		const opened = captureShadow();
		pwExtBanner(true, '<img src=x onerror="alert(1)"><b>x</b>');
		const root = opened.root as ShadowRoot;
		expect(root.querySelector("b")).toBeNull();
		expect(root.querySelector("img")).toBeNull();
		expect(root.textContent).toContain("<b>x</b>");
	});

	it("shows the banner again after the page removed it", () => {
		pwExtBanner(true);
		hosts()[0]?.remove();
		pwExtBanner(true);
		expect(hosts()).toHaveLength(1);
	});

	it("hides the banner", () => {
		pwExtBanner(true);
		pwExtBanner(false);
		expect(hosts()).toHaveLength(0);
	});

	it("sends Stop only for a trusted click", () => {
		const opened = captureShadow();
		pwExtBanner(true);
		const button = opened.root?.querySelector("button") as unknown as HTMLButtonElement;
		expect(button.textContent).toBe("Stop");
		expect(opened.root?.textContent).toContain("Agent is driving this tab");
		button.click();
		expect(sent).toEqual([]);
		const trusted = new window.MouseEvent("click");
		Object.defineProperty(trusted, "isTrusted", { value: true });
		button.dispatchEvent(trusted as never);
		expect(sent).toEqual([{ type: PW_EXT_STOP_MESSAGE }]);
		expect(hosts()).toHaveLength(0);
	});
});

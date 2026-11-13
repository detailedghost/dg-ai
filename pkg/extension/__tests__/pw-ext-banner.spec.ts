import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { PW_EXT_STOP_MESSAGE, pwExtBanner } from "@/lib/features/pw-ext-banner";

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

describe("agent banner", () => {
	it("shows one banner with no page-readable text", () => {
		pwExtBanner(true);
		pwExtBanner(true);
		expect(hosts()).toHaveLength(1);
		const host = hosts()[0] as unknown as { shadowRoot: unknown; textContent: string };
		expect(host.shadowRoot).toBeNull();
		expect(host.textContent).toBe("");
	});

	it("keeps the banner host out of the page layout", () => {
		pwExtBanner(true);
		const host = hosts()[0] as unknown as HTMLElement;
		expect(host.style.getPropertyValue("position")).toBe("fixed");
		expect(host.style.getPropertyPriority("position")).toBe("important");
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
		const opened: { root?: ShadowRoot } = {};
		const attach = window.HTMLElement.prototype.attachShadow;
		window.HTMLElement.prototype.attachShadow = function (this: HTMLElement, init: ShadowRootInit) {
			opened.root = attach.call(this, init) as unknown as ShadowRoot;
			return opened.root as never;
		};
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

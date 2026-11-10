import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { mountWebMcpScriptsPanel } from "../entrypoints/options/webmcp-scripts";
import { createWebMcpScripts, handleWebMcpRequest } from "@/lib/background/webmcp-scripts";

const windows = new Set<Window>();

afterEach(async () => {
	await Promise.all([...windows].map((window) => window.happyDOM.close()));
	windows.clear();
});

const UNAVAILABLE_NOTE =
	"Third-party scripts need Chrome 120 or newer and the Allow User Scripts toggle for dg-ai-extension on chrome://extensions (Developer mode before Chrome 138).";

function memoryStorage() {
	const data: Record<string, unknown> = {};
	return {
		data,
		local: {
			get: async (keys: string | string[] | null) => {
				if (keys === null) return { ...data };
				const wanted = Array.isArray(keys) ? keys : [keys];
				return Object.fromEntries(wanted.filter((key) => key in data).map((key) => [key, data[key]]));
			},
			set: async (items: Record<string, unknown>) => void Object.assign(data, items),
			remove: async (keys: string | string[]) => {
				for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
			},
		},
	};
}

function change(target: Element): void {
	const view = target.ownerDocument.defaultView as unknown as { Event: typeof Event };
	target.dispatchEvent(new view.Event("change"));
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount({ available = true } = {}) {
	const window = new Window();
	windows.add(window);
	const document = window.document as unknown as Document;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const storage = memoryStorage();
	const scripts = createWebMcpScripts({ storage, scripting: null, userScripts: null, newId: () => "s1" });
	const messages: { type: string; [key: string]: unknown }[] = [];
	mountWebMcpScriptsPanel(container, {
		available,
		request: async (message) => {
			messages.push(message);
			return handleWebMcpRequest(scripts, message);
		},
	});
	await settle();
	const q = <T extends Element>(selector: string) => container.querySelector(selector) as unknown as T;
	const button = (label: string) =>
		[...container.querySelectorAll("button")].find(
			(entry) => entry.textContent === label,
		) as unknown as HTMLButtonElement;
	const type = (selector: string, value: string) => {
		const field = q<HTMLInputElement | HTMLTextAreaElement>(selector);
		field.value = value;
	};
	const add = async (name = "Flights") => {
		type("[data-webmcp-name]", name);
		type("[data-webmcp-sites]", "https://flights.example.com/*\nhttps://deals.example.com/*");
		type("[data-webmcp-code]", "registerDgTool({});");
		button("Add script").click();
		await settle();
	};
	const writes = () => messages.filter((message) => !["dg-webmcp:list", "dg-webmcp:code"].includes(message.type));
	return { container, scripts, storage, messages, writes, q, button, add };
}

describe("web mcp scripts panel", () => {
	it("shows the heading, the outlook built-in row with a checked checkbox and the third-party form", async () => {
		const { container, q } = await mount();

		expect(container.textContent).toContain("Web MCP scripts");
		const row = q<HTMLElement>('[data-webmcp-row="outlook"]');
		expect(row.textContent).toContain("Outlook on the web");
		expect(row.textContent).toContain("https://outlook.live.com/*");
		expect(q<HTMLInputElement>('[data-webmcp-row="outlook"] input[type="checkbox"]').checked).toBe(true);
		expect(q("[data-webmcp-name]")).not.toBeNull();
		expect(q("[data-webmcp-sites]")).not.toBeNull();
		expect(q("[data-webmcp-code]")).not.toBeNull();
		expect(q('input[type="file"]')).not.toBeNull();
		expect(container.textContent).toContain("dg_<site>_<verb>");
	});

	it("keeps the form enabled and hides the toggle note when available", async () => {
		const { container, q } = await mount();

		expect(q<HTMLTextAreaElement>("[data-webmcp-code]").disabled).toBe(false);
		expect(container.textContent).not.toContain(UNAVAILABLE_NOTE);
	});

	it("disables every form control and shows the toggle note when userScripts is unavailable", async () => {
		const { container, q, button } = await mount({ available: false });

		expect(container.textContent).toContain(UNAVAILABLE_NOTE);
		for (const selector of [
			"[data-webmcp-name]",
			"[data-webmcp-sites]",
			"[data-webmcp-code]",
			'input[type="file"]',
		]) {
			expect(q<HTMLInputElement>(selector).disabled, selector).toBe(true);
		}
		expect(button("Add script").disabled).toBe(true);
	});

	it("adds a script as needs approval with the first 12 hex of its hash and no message sent before the write", async () => {
		const { q, add, writes } = await mount();

		await add();

		const row = q<HTMLElement>('[data-webmcp-row="s1"]');
		expect(row.textContent).toContain("Flights");
		expect(row.textContent).toContain("https://deals.example.com/*");
		expect(row.textContent).toContain("needs approval");
		expect(row.querySelector("[data-webmcp-sha]")?.textContent).toMatch(/^[0-9a-f]{12}$/);
		expect(writes()).toEqual([
			{
				type: "dg-webmcp:add",
				name: "Flights",
				matches: ["https://flights.example.com/*", "https://deals.example.com/*"],
				code: "registerDgTool({});",
				source: "paste",
			},
		]);
	});

	it("approves, then toggles Disable and Enable and shows the status", async () => {
		const { q, add, button } = await mount();
		await add();

		button("Approve").click();
		await settle();
		expect(q<HTMLElement>('[data-webmcp-row="s1"]').textContent).toContain("approved");

		button("Disable").click();
		await settle();
		expect(q<HTMLElement>('[data-webmcp-row="s1"]').textContent).toContain("disabled");

		button("Enable").click();
		await settle();
		expect(q<HTMLElement>('[data-webmcp-row="s1"]').textContent).toContain("approved");
	});

	it("shows the stored code read-only and every site next to Approve", async () => {
		const { q, add } = await mount();

		await add();

		const row = q<HTMLElement>('[data-webmcp-row="s1"]');
		const view = row.querySelector("pre[data-webmcp-code-view]");
		expect(view?.textContent).toBe("registerDgTool({});");
		expect(row.textContent).toContain("https://flights.example.com/*");
		expect(row.textContent).toContain("https://deals.example.com/*");
	});

	it("shows the refusal and stays unapproved when the code changed after it was shown", async () => {
		const { q, add, button, storage, container } = await mount();
		await add();
		storage.data["webmcpScriptCode:s1"] = "swapped();";

		button("Approve").click();
		await settle();

		expect(container.querySelector('[role="status"]')?.textContent).toContain("Script code changed; review it again.");
		expect(q<HTMLElement>('[data-webmcp-row="s1"]').textContent).toContain("needs approval");
	});

	it("removes a third-party row but gives the built-in no Remove button", async () => {
		const { q, add, button } = await mount();
		await add();
		expect(q<HTMLElement>('[data-webmcp-row="outlook"]').querySelector("button")).toBeNull();

		button("Remove").click();
		await settle();

		expect(q('[data-webmcp-row="s1"]')).toBeNull();
	});

	it("toggles the built-in through its checkbox", async () => {
		const { q, scripts, writes } = await mount();
		const box = q<HTMLInputElement>('[data-webmcp-row="outlook"] input[type="checkbox"]');

		box.checked = false;
		change(box);
		await settle();

		expect((await scripts.list())[0]?.enabled).toBe(false);
		expect(writes()).toEqual([{ type: "dg-webmcp:set-enabled", id: "outlook", enabled: false }]);
	});

	it("replaces the code from a chosen file and returns the row to needs approval", async () => {
		const { q, add, button, scripts } = await mount();
		await add();
		button("Approve").click();
		await settle();
		const input = q<HTMLInputElement>('[data-webmcp-row="s1"] input[type="file"]');
		Object.defineProperty(input, "files", {
			value: [{ name: "new.js", text: async () => "next();" }],
		});

		change(input);
		await settle();

		expect(q<HTMLElement>('[data-webmcp-row="s1"]').textContent).toContain("needs approval");
		expect((await scripts.list()).find((record) => record.id === "s1")?.approvedAt).toBeUndefined();
	});

	it("defaults an empty name to the chosen file name and records the file source", async () => {
		const { q, button, scripts } = await mount();
		const input = q<HTMLInputElement>("form [data-webmcp-file]");
		Object.defineProperty(input, "files", {
			value: [{ name: "deals.js", text: async () => "deal();" }],
		});
		change(input);
		await settle();
		(q<HTMLTextAreaElement>("[data-webmcp-sites]")).value = "https://deals.example.com/*";

		button("Add script").click();
		await settle();

		expect((await scripts.list()).find((record) => record.id === "s1")).toMatchObject({
			name: "deals.js",
			source: "file",
		});
	});

	it("sends the matching message for add, approve, disable, enable, replace and remove", async () => {
		const { q, add, button, writes } = await mount();
		await add();
		button("Approve").click();
		await settle();
		button("Disable").click();
		await settle();
		button("Enable").click();
		await settle();
		const input = q<HTMLInputElement>('[data-webmcp-row="s1"] input[type="file"]');
		Object.defineProperty(input, "files", { value: [{ name: "n.js", text: async () => "n();" }] });
		change(input);
		await settle();
		button("Remove").click();
		await settle();

		const sha = (writes()[1] as unknown as { sha256: string }).sha256;
		expect(sha).toMatch(/^[0-9a-f]{64}$/);
		expect(writes().map(({ type, ...rest }) => [type, rest])).toEqual([
			["dg-webmcp:add", expect.any(Object)],
			["dg-webmcp:approve", { id: "s1", sha256: sha }],
			["dg-webmcp:set-enabled", { id: "s1", enabled: false }],
			["dg-webmcp:set-enabled", { id: "s1", enabled: true }],
			["dg-webmcp:replace", { id: "s1", code: "n();" }],
			["dg-webmcp:remove", { id: "s1" }],
		]);
	});

	it("shows the rejection message and sends nothing when add fails", async () => {
		const { container, q, button, writes, scripts } = await mount();
		(q<HTMLInputElement>("[data-webmcp-name]")).value = "Bad";
		(q<HTMLTextAreaElement>("[data-webmcp-sites]")).value = "<all_urls>";
		(q<HTMLTextAreaElement>("[data-webmcp-code]")).value = "x();";

		button("Add script").click();
		await settle();

		expect(container.querySelector('[role="status"]')?.textContent).toContain("match pattern");
		expect(writes().map((message) => message.type)).toEqual(["dg-webmcp:add"]);
		expect(await scripts.list()).toHaveLength(1);
	});

	it("renders a hostile script name as text, not markup", async () => {
		const { q, add } = await mount();

		await add('<img src=x onerror="boom()">');

		const row = q<HTMLElement>('[data-webmcp-row="s1"]');
		expect(row.querySelector("img")).toBeNull();
		expect(row.textContent).toContain('<img src=x onerror="boom()">');
	});

	it("reads records and code only through list and code messages", async () => {
		const { messages, add } = await mount();
		await add();

		const types = new Set(messages.map((message) => message.type));

		expect(types.has("dg-webmcp:list")).toBe(true);
		expect(types.has("dg-webmcp:code")).toBe(true);
	});

	it("never touches scripting or userScripts itself", () => {
		const source = require("node:fs").readFileSync(
			new URL("../entrypoints/options/webmcp-scripts.ts", import.meta.url),
			"utf8",
		) as string;

		expect(source).not.toMatch(/registerContentScripts|userScripts|innerHTML|storage/);
	});
});

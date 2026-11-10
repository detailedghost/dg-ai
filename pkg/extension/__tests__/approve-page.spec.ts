import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const restore: Array<() => void> = [];

afterEach(() => {
	for (const undo of restore.splice(0).reverse()) undo();
});

function setGlobal(name: string, value: unknown): void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	restore.push(() => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	});
}

test("the approval page focuses no button, so a stray Enter or Space cannot answer it", async () => {
	const window = new Window({ url: "chrome-extension://dg/approve.html?id=id1" });
	const html = readFileSync(new URL("../entrypoints/approve/index.html", import.meta.url), "utf8");
	window.document.body.innerHTML = html.slice(html.indexOf("<main>"), html.indexOf("</main>") + 7);
	const sent: unknown[] = [];
	const sendMessage = mock(async (message: { type: string }) => {
		sent.push(message);
		return message.type === "dg-approval:get" ? { title: "T", origin: "https://a.test", lines: ["x"] } : true;
	});
	setGlobal("document", window.document);
	setGlobal("location", window.location);
	setGlobal("window", window);
	setGlobal("browser", { runtime: { sendMessage } });
	await import("@/entrypoints/approve/main");
	for (let i = 0; i < 20; i++) await Promise.resolve();
	expect(window.document.getElementById("actions")?.hidden).toBe(false);
	const focused = window.document.activeElement;
	expect(focused?.id === "deny" || focused?.id === "allow").toBe(false);
	expect(sent).toEqual([{ type: "dg-approval:get", id: "id1" }]);
	await window.happyDOM.close();
});

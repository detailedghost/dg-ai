import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalMessagesBrowser } from "../src/google/browser";
import { createGoogleProvider } from "../src/google/provider";
import { createDocument, node } from "./support/document";

describe("google provider", () => {
	test("receive waits with irregular gaps until a message appears", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-grecv-"));
		let reads = 0;
		const doc = createDocument(
			[
				node("c1", { href: "/web/conversations/c1" }),
				node("secret-body", { id: "m9", datetime: "9", "aria-label": "ada" }, "MWS-MESSAGE-WRAPPER"),
			],
			"Conversations",
		);
		const browser = createLocalMessagesBrowser(doc);
		const real = browser.act.bind(browser);
		browser.act = async (action, args) => {
			if (action === "read") {
				reads += 1;
				if (reads === 1) return { messages: [] };
			}
			return real(action, args);
		};
		const waits: number[] = [];
		let clock = 0;
		const provider = createGoogleProvider({
			browser,
			home,
			now: () => clock,
			sleep: async (ms) => {
				waits.push(ms);
				clock += ms;
			},
			rng: () => 0,
		});
		const messages = await provider.receive({ limit: 1, timeoutMs: 10_000, conversationId: "c1" });
		expect(messages.map((item) => item.id)).toEqual(["m9"]);
		expect(waits).toEqual([200]);
		expect(JSON.stringify(messages[0]?.text)).toBe('"secret-body"');
	});

	test("a second quiet poll does not reuse the same gap", async () => {
		const home = mkdtempSync(join(tmpdir(), "ssms-gquiet-"));
		const doc = createDocument([node("c1", { href: "/web/conversations/c1" })], "");
		const browser = createLocalMessagesBrowser(doc);
		const waits: number[] = [];
		let clock = 0;
		const rolls = [0, 0, 0, 0, 0, 0];
		let index = 0;
		const provider = createGoogleProvider({
			browser,
			home,
			now: () => clock,
			sleep: async (ms) => {
				waits.push(ms);
				clock += ms;
			},
			rng: () => rolls[index++] ?? 0,
		});
		await provider.receive({ limit: 1, timeoutMs: 600, conversationId: "c1" });
		expect(waits.length).toBeGreaterThan(1);
		expect(waits[0]).not.toBe(waits[1]);
		expect(new Set(waits).size).toBeGreaterThan(1);
	});
});

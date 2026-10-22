import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dispatchExt } from "../../../src/pw/ext/dispatch";
import type { ExtOutcome, ExtRequest, ExtTransport } from "../../../src/pw/ext/protocol";
import { clientEnv, useTempScratch } from "../../../src/pw/test-support";

const TAB = { url: "https://example.test/", title: "Example" };

function fakeTransport(outcome: ExtOutcome, seen: ExtRequest[] = []): ExtTransport {
	return async (request) => {
		seen.push(request);
		return outcome;
	};
}

describe("dispatchExt argument validation", () => {
	test("rejects an unknown verb without calling the transport", async () => {
		const seen: ExtRequest[] = [];
		const env = clientEnv();
		const code = await dispatchExt(["dance"], env, fakeTransport({ status: "approved", tab: TAB, payload: { kind: "ack" } }, seen));
		expect(code).toBe(2);
		expect(seen).toEqual([]);
		expect(env.stderr[0]).toContain("unknown or unsupported verb");
	});

	test("refuses a browser-settings URL before the transport ever runs", async () => {
		const seen: ExtRequest[] = [];
		const env = clientEnv();
		const code = await dispatchExt(
			["open", "chrome://settings"],
			env,
			fakeTransport({ status: "approved", tab: TAB, payload: { kind: "ack" } }, seen),
		);
		expect(code).toBe(2);
		expect(seen).toEqual([]);
		expect(env.stderr[0]).toContain("refusing to open chrome:");
	});

	test("refuses an extension page", async () => {
		const env = clientEnv();
		const code = await dispatchExt(["open", "chrome-extension://abc/page.html"], env, fakeTransport({
			status: "approved",
			tab: TAB,
			payload: { kind: "ack" },
		}));
		expect(code).toBe(2);
	});

	test("rejects fill without a value", async () => {
		const env = clientEnv();
		const code = await dispatchExt(["fill", "#email"], env, fakeTransport({
			status: "approved",
			tab: TAB,
			payload: { kind: "ack" },
		}));
		expect(code).toBe(2);
		expect(env.stderr[0]).toContain("provide a target and a value");
	});

	test("rejects a non-integer snapshot depth", async () => {
		const env = clientEnv();
		const code = await dispatchExt(["snapshot", "--depth=abc"], env, fakeTransport({
			status: "approved",
			tab: TAB,
			payload: { kind: "snapshot", text: "x" },
		}));
		expect(code).toBe(2);
	});
});

describe("dispatchExt write verbs", () => {
	test("builds the open request and prints the tab on approval", async () => {
		const seen: ExtRequest[] = [];
		const env = clientEnv();
		const code = await dispatchExt(
			["open", "https://example.test/"],
			env,
			fakeTransport({ status: "approved", tab: TAB, payload: { kind: "ack" } }, seen),
		);
		expect(code).toBe(0);
		expect(seen).toEqual([{ verb: "open", url: "https://example.test/" }]);
		expect(env.stdout[0]).toContain(TAB.title);
	});

	test("builds the fill request with --submit", async () => {
		const seen: ExtRequest[] = [];
		const env = clientEnv();
		await dispatchExt(
			["fill", "#email", "user@example.com", "--submit"],
			env,
			fakeTransport({ status: "approved", tab: TAB, payload: { kind: "ack" } }, seen),
		);
		expect(seen).toEqual([{ verb: "fill", target: "#email", value: "user@example.com", submit: true }]);
	});

	test("a denial exits 1 and names the tab and verb kind", async () => {
		const env = clientEnv();
		const code = await dispatchExt(["click", "#submit"], env, fakeTransport({ status: "denied", tab: TAB }));
		expect(code).toBe(1);
		expect(env.stderr[0]).toContain("denied for tab");
		expect(env.stderr[0]).toContain(TAB.title);
		expect(env.stderr[0]).toContain("write access to click");
	});

	test("a blocked outcome exits 1 with the reason", async () => {
		const env = clientEnv();
		const code = await dispatchExt(["click", "#submit"], env, fakeTransport({ status: "blocked", reason: "other extension's page" }));
		expect(code).toBe(1);
		expect(env.stderr[0]).toContain("other extension's page");
	});
});

describe("dispatchExt read verbs", () => {
	test("current lists the active tab and open tabs", async () => {
		const env = clientEnv();
		const code = await dispatchExt(
			["current"],
			env,
			fakeTransport({
				status: "approved",
				tab: TAB,
				payload: { kind: "tabs", active: TAB, tabs: [TAB, { url: "https://other.test/", title: "Other" }] },
			}),
		);
		expect(code).toBe(0);
		expect(env.stdout[0]).toContain("Current tab");
		expect(env.stdout[0]).toContain("Other");
	});
});

describe("dispatchExt console", () => {
	test("reports no entries plainly", async () => {
		const env = clientEnv();
		const code = await dispatchExt(["console"], env, fakeTransport({
			status: "approved",
			tab: TAB,
			payload: { kind: "console", entries: [] },
		}));
		expect(code).toBe(0);
		expect(env.stdout[0]).toBe("(no console entries)");
	});

	test("formats entries by type", async () => {
		const env = clientEnv();
		await dispatchExt(["console"], env, fakeTransport({
			status: "approved",
			tab: TAB,
			payload: { kind: "console", entries: [{ type: "error", text: "boom" }] },
		}));
		expect(env.stdout[0]).toBe("[error] boom");
	});
});

describe("dispatchExt snapshot and selection", () => {
	test("prints the snapshot text directly on stdout, redacted", async () => {
		const env = clientEnv();
		await dispatchExt(["snapshot"], env, fakeTransport({
			status: "approved",
			tab: TAB,
			payload: { kind: "snapshot", text: '- textbox "Password" [value="hunter22"]' },
		}));
		expect(env.stdout[0]).not.toContain("hunter22");
	});

	test("prints the selected text", async () => {
		const env = clientEnv();
		await dispatchExt(["selection"], env, fakeTransport({
			status: "approved",
			tab: TAB,
			payload: { kind: "selection", text: "selected words" },
		}));
		expect(env.stdout[0]).toBe("selected words");
	});
});

describe("dispatchExt screenshot", () => {
	const scratch = useTempScratch();

	test("writes the decoded image to scratch and prints the path", async () => {
		const env = clientEnv();
		const bytes = Buffer.from("fake-png-bytes");
		const code = await dispatchExt(
			["screenshot"],
			env,
			fakeTransport({ status: "approved", tab: TAB, payload: { kind: "screenshot", dataBase64: bytes.toString("base64") } }),
		);
		expect(code).toBe(0);
		const match = /^Saved (.+)$/.exec(env.stdout[0] ?? "");
		expect(match).not.toBeNull();
		const path = match?.[1] as string;
		expect(path.startsWith(scratch.dir)).toBe(true);
		expect(readFileSync(path)).toEqual(bytes);
	});
});

import { describe, expect, test } from "bun:test";
import { createNotifier, redact } from "../src/automation/notify";
import { loadConfig } from "../src/config";
import { createFakeProvider, createRecordedLog, createTempHome, minimalConfigJson, writeConfigFile } from "./support/fakes";

const TOKEN = "a".repeat(32);

describe("redact", () => {
	test("removes emails", () => {
		expect(redact("failed for jane.doe@example.com today")).toBe("failed for [email] today");
	});

	test("removes tokens of 32 characters or more and keeps shorter ones", () => {
		expect(redact(`key ${TOKEN} and ${"b".repeat(31)}`)).toBe(`key [redacted] and ${"b".repeat(31)}`);
	});

	test("removes URL query strings", () => {
		expect(redact("see https://errors.example.com/issues/1?token=abc&x=1 now")).toBe(
			"see https://errors.example.com/issues/1 now",
		);
	});

	test("caps the text at 400 characters", () => {
		const out = redact("x ".repeat(500));
		expect(out).toHaveLength(400);
		expect(out.endsWith("…")).toBe(true);
	});

	test("leaves a short clean text alone", () => {
		expect(redact("Fix PR ready")).toBe("Fix PR ready");
	});
});

describe("createNotifier", () => {
	function setup(target?: string) {
		const home = createTempHome();
		const config = loadConfig(
			writeConfigFile(
				home.dir,
				minimalConfigJson(target === undefined ? {} : { automation: { notify: { target } } }),
			),
		);
		const provider = createFakeProvider();
		const log = createRecordedLog();
		return { notify: createNotifier({ provider, config, log }), provider, log, cleanup: home.cleanup };
	}

	test("sends a direct message to the owner by default", async () => {
		const run = setup();
		await run.notify("new error", "https://github.com/o/r/pull/1");
		expect(run.provider.dms).toEqual([{ text: "new error\nhttps://github.com/o/r/pull/1" }]);
		expect(run.provider.replies()).toEqual([]);
		run.cleanup();
	});

	test("replies to the chat when the target is a chat id", async () => {
		const run = setup("19:chat@thread.v2");
		await run.notify("new error");
		expect(run.provider.dms).toEqual([]);
		expect(run.provider.replies()).toMatchObject([{ chatId: "19:chat@thread.v2", text: "new error" }]);
		run.cleanup();
	});

	test("redacts the text but keeps the link whole", async () => {
		const run = setup();
		await run.notify(`oops ${TOKEN} owner@example.com`, "https://errors.example.com/i/1?tab=2");
		expect(run.provider.dms[0]?.text).toBe("oops [redacted] [email]\nhttps://errors.example.com/i/1?tab=2");
		run.cleanup();
	});

	test("logs instead of throwing when the send fails", async () => {
		const run = setup();
		run.provider.failReplies = true;
		await expect(run.notify("x")).resolves.toBeUndefined();
		expect(run.log.lines[0]?.level).toBe("warn");
		expect(run.log.lines[0]?.message).toContain("dm failed");
		run.cleanup();
	});
});

import { describe, expect, spyOn, test } from "bun:test";
import { type Launchers, openSession } from "../src/demo/player-process";
import type { BrowserPlan, PlayerJob } from "../src/demo/player-job";
import { createBridge, tourOrigins, trustedSource } from "../src/demo/bridge";
import { toPlanMarkdown } from "../src/utils/plan-format";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const session = (name: string) =>
	({ context: { name } as never, close: async () => {} });

const job = (video: boolean, plan?: BrowserPlan): PlayerJob => ({
	slug: "s",
	planPath: "/tmp/none",
	dir: "/tmp/none",
	video,
	startUrl: "https://example.test/",
	script: { title: "t", startUrl: "https://example.test/", steps: [] },
	...(plan ? { plan } : {}),
});

function launchers(windowsFails: boolean): Launchers & { used: string[] } {
	const used: string[] = [];
	return {
		used,
		pick: () => ({ channel: "chrome" }),
		local: async () => (used.push("local"), session("local")),
		windows: async () => {
			used.push("windows");
			if (windowsFails) throw new Error("recordVideo is not supported over CDP");
			return session("windows");
		},
	};
}

describe("openSession over the Windows plan", () => {
	const windows: BrowserPlan = { mode: "windows" };

	test("keeps the Windows session when it launches", async () => {
		const l = launchers(false);
		await openSession(job(true, windows), l);
		expect(l.used).toEqual(["windows"]);
	});

	test("falls back to a headless local Chromium for --video and prints one line", async () => {
		const log = spyOn(console, "log").mockImplementation(() => undefined);
		const l = launchers(true);
		await openSession(job(true, windows), l);
		expect(l.used).toEqual(["windows", "local"]);
		expect(log).toHaveBeenCalledTimes(1);
		expect(String(log.mock.calls[0]?.[0])).toContain("headless local Chromium");
		log.mockRestore();
	});

	test("rethrows without --video", async () => {
		const l = launchers(true);
		await expect(openSession(job(false, windows), l)).rejects.toThrow("CDP");
		expect(l.used).toEqual(["windows"]);
	});
});

describe("bridge", () => {
	const dir = mkdtempSync(join(tmpdir(), "dg-bridge-"));
	const bridge = createBridge({
		job: { dir, planPath: join(dir, "s.demo.md"), slug: "s", video: false },
	});

	test("answers storage messages from the held map", async () => {
		await bridge.handle({ kind: "storage-set", key: "k", value: { a: 1 } });
		expect(await bridge.handle({ kind: "storage-get", key: "k" })).toEqual({ a: 1 });
		await bridge.handle({ kind: "storage-remove", key: "k" });
		expect(await bridge.handle({ kind: "storage-get", key: "k" })).toBeUndefined();
	});

	test("persists a choice and answers captions-only", async () => {
		const answer = await bridge.handle({
			kind: "choice",
			mode: "video",
			narration: "voice",
			voice: "af_heart",
			includeSetup: false,
		});
		expect(answer).toBe("captions-only");
		expect(JSON.parse(readFileSync(join(dir, "choice.json"), "utf8")).mode).toBe("video");
		expect(bridge.mode()).toBe("video");
	});

	test("writes a downloaded plan next to the saved one and ends on done", async () => {
		await bridge.handle({ kind: "download-plan", markdown: toPlanMarkdown({ title: "Edited", startUrl: "https://example.test/", steps: [{ title: "One", body: "b" }] }) });
		expect(readdirSync(dir)).toContain("s.edited.demo.md");
		await bridge.handle({ kind: "done" });
		expect(await bridge.done).toEqual({ outcome: "done" });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("bridge terminal and progress messages", () => {
	const make = (onProgress?: (i: number) => void) =>
		createBridge({
			job: { dir: "/tmp/none", planPath: "/tmp/none/s.demo.md", slug: "s", video: false },
			onProgress,
		});

	test("starts in walkthrough mode, or video when the job records", () => {
		expect(make().mode()).toBe("walkthrough");
		const recording = createBridge({
			job: { dir: "/tmp/none", planPath: "/tmp/none/s.demo.md", slug: "s", video: true },
		});
		expect(recording.mode()).toBe("video");
	});

	test("forwards the step index of a progress message as a number", async () => {
		const seen: number[] = [];
		await make((i) => void seen.push(i)).handle({ kind: "progress", index: "3" });
		expect(seen).toEqual([3]);
	});

	test("ends with stopped", async () => {
		const bridge = make();
		await bridge.handle({ kind: "stopped" });
		expect(await bridge.done).toEqual({ outcome: "stopped" });
	});

	test("ends with error and carries the message", async () => {
		const bridge = make();
		await bridge.handle({ kind: "error", message: "boom" });
		expect(await bridge.done).toEqual({ outcome: "error", error: "boom" });
	});

	test("answers narration messages captions-only until narration lands", async () => {
		const bridge = make();
		expect(await bridge.handle({ kind: "narration-complete" })).toBe("captions-only");
		expect(await bridge.handle({ kind: "clip" })).toBe("captions-only");
	});

	test("ignores non-object and unknown messages without ending the run", async () => {
		const bridge = make();
		expect(await bridge.handle(null)).toBeUndefined();
		expect(await bridge.handle("done")).toBeUndefined();
		expect(await bridge.handle({ kind: "mystery" })).toBeUndefined();
		const pending = await Promise.race([bridge.done, Promise.resolve("pending")]);
		expect(pending).toBe("pending");
	});

	test("keeps the mode when a choice names an unknown mode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-bridge-choice-"));
		const bridge = createBridge({
			job: { dir, planPath: join(dir, "s.demo.md"), slug: "s", video: false },
		});
		await bridge.handle({ kind: "choice", mode: "weird" });
		expect(bridge.mode()).toBe("walkthrough");
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("bridge input limits", () => {
	const dir = mkdtempSync(join(tmpdir(), "dg-bridge-limits-"));
	const make = () =>
		createBridge({
			job: { dir, planPath: join(dir, "s.demo.md"), slug: "s", video: false },
		});

	test("keeps only known choice values", async () => {
		const bridge = make();
		await bridge.handle({
			kind: "choice",
			mode: "../../etc",
			narration: "shout",
			voice: "x".repeat(10),
			includeSetup: "yes",
		});
		const saved = JSON.parse(readFileSync(join(dir, "choice.json"), "utf8"));
		expect(saved).toEqual({ mode: "walkthrough", includeSetup: false });
		expect(bridge.mode()).toBe("walkthrough");
	});

	test("ignores a downloaded plan that does not parse", async () => {
		const bridge = make();
		expect(await bridge.handle({ kind: "download-plan", markdown: "rm -rf" })).toBeUndefined();
		expect(readdirSync(dir)).not.toContain("s.edited.demo.md");
	});

	test("ignores a message over the size limit", async () => {
		const bridge = make();
		await bridge.handle({ kind: "storage-set", key: "k", value: "x".repeat(70_000) });
		expect(await bridge.handle({ kind: "storage-get", key: "k" })).toBeUndefined();
	});

	test("caps the length of an error message", async () => {
		const bridge = make();
		await bridge.handle({ kind: "error", message: "e".repeat(5000) });
		expect((await bridge.done).error).toHaveLength(500);
	});

	test("writes choice.json readable only by the owner", async () => {
		await make().handle({ kind: "choice", mode: "video", narration: "both", voice: "af_heart" });
		expect(statSync(join(dir, "choice.json")).mode & 0o777).toBe(0o600);
	});
});

describe("trustedSource", () => {
	const script = {
		title: "t",
		startUrl: "https://example.test/start",
		steps: [{ title: "a", body: "b", navigate: "https://other.test/page" }],
	};
	const origins = tourOrigins(script);
	const top = { url: () => "https://example.test/x" };
	const page = (main: unknown) => ({ mainFrame: () => main });

	test("collects the start origin and each navigate origin", () => {
		expect([...origins].sort()).toEqual(["https://example.test", "https://other.test"]);
	});

	test("accepts the main frame on a plan origin", () => {
		expect(trustedSource({ frame: top, page: page(top) }, origins)).toBe(true);
	});

	test("rejects a child frame", () => {
		const child = { url: () => "https://example.test/frame" };
		expect(trustedSource({ frame: child, page: page(top) }, origins)).toBe(false);
	});

	test("rejects the main frame on a foreign origin", () => {
		const evil = { url: () => "https://evil.test/" };
		expect(trustedSource({ frame: evil, page: page(evil) }, origins)).toBe(false);
	});
});

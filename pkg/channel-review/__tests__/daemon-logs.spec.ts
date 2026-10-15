import { afterEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	renameSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { logs } from "../src/daemon";
import { type DaemonHarness, createDaemonHarness } from "./daemon-harness";
import { waitUntil } from "./support/fakes";

const harnesses: DaemonHarness[] = [];

function setup(): DaemonHarness {
	const harness = createDaemonHarness();
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

function writeLog(h: DaemonHarness, text: string): void {
	mkdirSync(dirname(h.paths.logPath), { recursive: true });
	writeFileSync(h.paths.logPath, text);
}

const numbered = (count: number) =>
	Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n").concat("\n");

describe("logs", () => {
	test("prints the path and no log yet, exit 0, when the file is missing", async () => {
		const h = setup();
		expect(await logs({}, { io: h.io, system: h.system })).toBe(0);
		expect(h.io.outLines).toEqual([`${h.paths.logPath}: no log yet`]);
	});

	test("prints the last 40 lines by default", async () => {
		const h = setup();
		writeLog(h, numbered(100));
		expect(await logs({}, { io: h.io, system: h.system })).toBe(0);
		expect(h.io.outLines).toHaveLength(40);
		expect(h.io.outLines[0]).toBe("line 61");
		expect(h.io.outLines.at(-1)).toBe("line 100");
	});

	test("prints the last n lines and every line of a short file", async () => {
		const h = setup();
		writeLog(h, numbered(5));
		await logs({ lines: 2 }, { io: h.io, system: h.system });
		expect(h.io.outLines).toEqual(["line 4", "line 5"]);
		h.io.outLines.length = 0;
		await logs({ lines: 50 }, { io: h.io, system: h.system });
		expect(h.io.outLines).toHaveLength(5);
	});

	test("reads the log of the selected env", async () => {
		const h = setup();
		const prod = h.pathsFor("prod").logPath;
		mkdirSync(dirname(prod), { recursive: true });
		writeFileSync(prod, "prod line\n");
		await logs({ env: "prod" }, { io: h.io, system: h.system });
		expect(h.io.outLines).toEqual(["prod line"]);
	});

	test.each([0, -1, 1.5, Number.NaN])("rejects --lines %p with exit 1", async (lines) => {
		const h = setup();
		expect(await logs({ lines }, { io: h.io, system: h.system })).toBe(1);
		expect(h.io.errLines.join("\n")).toContain("--lines");
	});

	test("rejects an unknown env with exit 1", async () => {
		const h = setup();
		expect(await logs({ env: "staging" }, { io: h.io, system: h.system })).toBe(1);
		expect(h.io.errLines.join("\n")).toContain("dev or prod");
	});

	describe("follow", () => {
		const follow = (h: DaemonHarness, controller: AbortController) =>
			logs(
				{ follow: true, lines: 1 },
				{ io: h.io, system: h.system, signal: controller.signal, pollIntervalMs: 10 },
			);

		test("prints appended lines, holding a partial line until it ends", async () => {
			const h = setup();
			writeLog(h, "first\n");
			const controller = new AbortController();
			const done = follow(h, controller);
			await waitUntil(() => h.io.outLines.length === 1);
			appendFileSync(h.paths.logPath, "second\nthi");
			await waitUntil(() => h.io.outLines.includes("second"));
			expect(h.io.outLines).not.toContain("thi");
			appendFileSync(h.paths.logPath, "rd\n");
			await waitUntil(() => h.io.outLines.includes("third"));
			controller.abort();
			expect(await done).toBe(0);
		});

		test("keeps printing after the log is truncated by a copy-truncate rotation", async () => {
			const h = setup();
			writeLog(h, "aaaaaaaaaa\nbbbbbbbbbb\n");
			const controller = new AbortController();
			const done = follow(h, controller);
			await waitUntil(() => h.io.outLines.length === 1);
			truncateSync(h.paths.logPath, 0);
			appendFileSync(h.paths.logPath, "after\n");
			await waitUntil(() => h.io.outLines.includes("after"));
			controller.abort();
			await done;
		});

		test("keeps printing after the log is replaced by a rename rotation", async () => {
			const h = setup();
			writeLog(h, "old one\nold two\n");
			const controller = new AbortController();
			const done = follow(h, controller);
			await waitUntil(() => h.io.outLines.length === 1);
			renameSync(h.paths.logPath, `${h.paths.logPath}.1`);
			writeLog(h, "x\ny\nfresh\nmore\n");
			await waitUntil(() => h.io.outLines.includes("more"));
			expect(h.io.outLines).toContain("x");
			controller.abort();
			await done;
		});
	});
});

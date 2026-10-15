import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "@dg/common/node";

let dir: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "runners-capture-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bun = (code: string) => [process.execPath, ["-e", code]] as const;

describe("runCapture options", () => {
	test("keeps capturing stdout and exit status without options", async () => {
		const [command, args] = bun(`console.log("hello")`);
		const result = await runCapture(command, [...args]);
		expect(result).toMatchObject({ status: 0, stdout: "hello\n" });
	});

	test("keeps feeding stdin for existing callers", async () => {
		const [command, args] = bun(
			`console.log((await Bun.stdin.text()).toUpperCase())`,
		);
		const result = await runCapture(command, [...args], { stdin: "abc" });
		expect(result.stdout.trim()).toBe("ABC");
	});

	test("runs the child in the cwd option", async () => {
		const [command, args] = bun(`console.log(process.cwd())`);
		const result = await runCapture(command, [...args], { cwd: dir });
		expect(result.stdout.trim()).toBe(dir);
	});

	test("kills a child with SIGKILL when timeoutMs expires", async () => {
		const [command, args] = bun(
			`process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`,
		);
		const started = Date.now();
		const result = await runCapture(command, [...args], { timeoutMs: 300 });
		expect(Date.now() - started).toBeLessThan(3000);
		expect(result.signal).toBe("SIGKILL");
		expect(result.status).not.toBe(0);
	});

	test("does not kill a child that finishes before timeoutMs", async () => {
		const [command, args] = bun(`console.log("fast")`);
		const result = await runCapture(command, [...args], { timeoutMs: 10_000 });
		expect(result).toMatchObject({ status: 0, signal: null, stdout: "fast\n" });
	});
});

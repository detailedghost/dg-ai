import { describe, expect, test } from "bun:test";
import { emitJson } from "../src/utils/json";

describe("emitJson", () => {
	test("writes pretty-printed JSON followed by newline to stdout", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { emitJson } from "${import.meta.dir}/../src/utils/json.ts"; emitJson({ a: 1, b: [2, 3] });`,
			],
			{ env: { ...process.env } },
		);
		const out = proc.stdout.toString();
		expect(out.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(out.trim());
		expect(parsed).toEqual({ a: 1, b: [2, 3] });
	});

	test("pretty-print uses 2-space indentation", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { emitJson } from "${import.meta.dir}/../src/utils/json.ts"; emitJson({ x: 1 });`,
			],
			{ env: { ...process.env } },
		);
		const out = proc.stdout.toString().trim();
		expect(out).toBe('{\n  "x": 1\n}');
	});

	test("handles null value", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { emitJson } from "${import.meta.dir}/../src/utils/json.ts"; emitJson(null);`,
			],
			{ env: { ...process.env } },
		);
		expect(proc.stdout.toString().trim()).toBe("null");
	});

	test("handles array value", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { emitJson } from "${import.meta.dir}/../src/utils/json.ts"; emitJson([1,"two",true]);`,
			],
			{ env: { ...process.env } },
		);
		const parsed = JSON.parse(proc.stdout.toString().trim());
		expect(parsed).toEqual([1, "two", true]);
	});
});

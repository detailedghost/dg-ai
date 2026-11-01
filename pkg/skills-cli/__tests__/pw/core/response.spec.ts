import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import {
	DEFAULT_DEPTH,
	eventLines,
	formatBytes,
	type Parts,
	render,
	resolveOutput,
	snapshotLine,
	timestampedName,
	writeSnapshot,
} from "../../../src/pw/core/response";
import { FakePage, useTempScratch } from "../../../src/pw/test-support";

const scratch = useTempScratch();

const everything: Parts = {
	error: "boom",
	result: "42",
	code: "await page.click();",
	page: { url: "https://a.test/", title: "A", errors: 1, warnings: 2 },
	snapshot: { path: "/tmp/ai/pw/x/page.yml", bytes: 6348, lines: 140 },
	events: [{ type: "error", text: "bad" }],
	modal: ["- [File chooser]: can be handled by upload"],
};

const headings = (text: string) =>
	text.split("\n").filter((line) => line.startsWith("### "));

describe("render", () => {
	test("orders sections Error, Result, Ran Playwright code, Page, Snapshot, Events, Modal state", () => {
		expect(headings(render(everything, { raw: false, codegen: true }))).toEqual(
			[
				"### Error",
				"### Result",
				"### Ran Playwright code",
				"### Page",
				"### Snapshot",
				"### Events",
				"### Modal state",
			],
		);
	});

	test("omits empty sections", () => {
		expect(render({ result: "ok" }, { raw: false, codegen: false })).toBe(
			"### Result\nok",
		);
		expect(render({}, { raw: false, codegen: false })).toBe("");
	});

	test("hides the generated code unless codegen is on", () => {
		expect(render(everything, { raw: false, codegen: false })).not.toContain(
			"Ran Playwright code",
		);
		expect(render(everything, { raw: false, codegen: true })).toContain(
			"```js\nawait page.click();\n```",
		);
	});

	test("raw prints only the error and result content", () => {
		expect(render(everything, { raw: true, codegen: true })).toBe("boom\n42");
		expect(render({ result: "42" }, { raw: true, codegen: false })).toBe("42");
	});

	test("prints the snapshot link with size and line count", () => {
		expect(render(everything, { raw: false, codegen: false })).toContain(
			"[Snapshot](/tmp/ai/pw/x/page.yml) 6.2 KB, 140 lines",
		);
	});

	test("prints the console counts in the page section only when non-zero", () => {
		const quiet = render(
			{ page: { url: "u", title: "", errors: 0, warnings: 0 } },
			{ raw: false, codegen: false },
		);
		expect(quiet).toBe("### Page\n- Page URL: u");
		expect(render(everything, { raw: false, codegen: false })).toContain(
			"- Console: 1 errors, 2 warnings",
		);
	});
});

describe("formatting", () => {
	test("formats bytes", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(6348)).toBe("6.2 KB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
	});

	test("uses the singular for one line", () => {
		expect(snapshotLine({ path: "/p", bytes: 10, lines: 1 })).toBe(
			"[Snapshot](/p) 10 B, 1 line",
		);
	});
});

describe("eventLines", () => {
	test("is empty when nothing happened", () => {
		expect(eventLines([])).toEqual([]);
	});

	test("lists counts and only the first three entries", () => {
		const entries = ["error", "warning", "log", "log", "log"].map(
			(type, i) => ({ type, text: `m${i}` }),
		);
		expect(eventLines(entries)).toEqual([
			"- Console: 5 new (1 error, 1 warning, 3 log)",
			"  - [error] m0",
			"  - [warning] m1",
			"  - [log] m2",
			"  - ... 2 more",
		]);
	});

	test("truncates long messages to their first line", () => {
		const [, entry] = eventLines([
			{ type: "log", text: `${"x".repeat(400)}\nsecond` },
		]);
		expect(entry?.length).toBeLessThan(220);
		expect(entry).not.toContain("second");
	});
});

describe("resolveOutput", () => {
	test("resolves a relative name against the output directory", () => {
		expect(resolveOutput(scratch.dir, "shot.png")).toBe(
			path.join(scratch.dir, "shot.png"),
		);
	});

	test("keeps an absolute name unchanged and creates its directory", () => {
		const target = path.join(scratch.dir, "nested", "x.png");
		expect(resolveOutput("/ignored", target)).toBe(target);
		expect(statSync(path.dirname(target)).isDirectory()).toBe(true);
	});

	test("builds a sortable timestamped name", () => {
		expect(timestampedName("page", "yml")).toMatch(
			/^page-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}\.yml$/,
		);
		expect(timestampedName("download", "bin")).not.toBe(
			timestampedName("download", "bin"),
		);
	});
});

describe("writeSnapshot", () => {
	test("writes the page snapshot and reports size and lines", async () => {
		const page = new FakePage();
		const link = await writeSnapshot(page as unknown as Page, scratch.dir, {
			depth: DEFAULT_DEPTH,
			filename: "s.yml",
		});
		expect(link).toEqual({
			path: path.join(scratch.dir, "s.yml"),
			bytes: 19,
			lines: 1,
		});
		expect(readFileSync(link.path, "utf8")).toBe("- generic [ref=e1]\n");
		expect(page.snapshotCalls).toEqual([{ mode: "ai", depth: DEFAULT_DEPTH }]);
	});

	test("snapshots the scope, then restores the page ref map with a shallow page snapshot", async () => {
		const page = new FakePage();
		const scope = { ariaSnapshot: async () => "- heading [ref=e3]" };
		await writeSnapshot(page as unknown as Page, scratch.dir, {
			depth: 4,
			scope,
			filename: "s.yml",
		});
		expect(page.snapshotCalls).toEqual([{ mode: "ai", depth: 1 }]);
	});
});

describe("event notices", () => {
	test("lists notices after the console entries in one Events section", () => {
		const text = render(
			{
				events: [{ type: "log", text: "hi" }],
				notices: ["- Downloaded a.csv to /tmp/a.csv"],
			},
			{ raw: false, codegen: false },
		);
		expect(text).toBe(
			"### Events\n- Console: 1 new (1 log)\n  - [log] hi\n- Downloaded a.csv to /tmp/a.csv",
		);
	});

	test("shows notices alone when there are no console entries", () => {
		expect(render({ notices: ["- n"] }, { raw: false, codegen: false })).toBe(
			"### Events\n- n",
		);
	});
});

describe("private output", () => {
	test("resolveOutput creates new parent directories as 0700 and keeps an existing one", () => {
		const existing = path.join(scratch.dir, "mine");
		mkdirSync(existing, { mode: 0o755 });
		chmodSync(existing, 0o755);
		const file = resolveOutput(
			scratch.dir,
			path.join(existing, "new", "deep", "x.png"),
		);
		expect(statSync(existing).mode & 0o777).toBe(0o755);
		expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		expect(statSync(path.join(existing, "new")).mode & 0o777).toBe(0o700);
	});

	test("writeSnapshot writes the file as 0600", async () => {
		const link = await writeSnapshot(
			new FakePage() as unknown as Page,
			scratch.dir,
			{ filename: "private.yml" },
		);
		expect(statSync(link.path).mode & 0o777).toBe(0o600);
	});
});

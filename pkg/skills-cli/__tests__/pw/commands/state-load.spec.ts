import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/state-load/run";
import spec from "../../../src/pw/commands/state-load/spec";

const scratch = useTempScratch();

import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseStorageState } from "../../../src/pw/core/states";
import { FakePage } from "../../../src/pw/test-support";

describe("parseStorageState", () => {
	test("accepts cookies and origins", () => {
		expect(parseStorageState('{"cookies":[],"origins":[]}', "f")).toEqual({ cookies: [], origins: [] });
	});

	test.each(["not json", "42", "null", "{}", '{"cookies":"x"}'])("rejects %p and names the file", (text) => {
		expect(() => parseStorageState(text, "/tmp/f.json")).toThrow("Not a storage state file: /tmp/f.json");
	});
});

describe("state-load", () => {
	test("adds cookies and restores localStorage through a temporary tab", async () => {
		const state = {
			cookies: [{ name: "sid", value: "1", domain: "a.test", path: "/" }],
			origins: [
				{ origin: "https://a.test", localStorage: [{ name: "k", value: "v" }] },
				{ origin: "https://b.test", localStorage: [] },
			],
		};
		const file = path.join(scratch.dir, "s.json");
		writeFileSync(file, JSON.stringify(state));
		const { ctx, page, context } = fakeCtx(scratch.dir);
		const temporary = new FakePage();
		context.returns["newPage"] = temporary;
		const result = await handler(ctx, argsFor(spec, file));
		expect(page.calls[0]).toStartWith("context.addCookies [[{");
		expect(temporary.calls).toContain("goto https://a.test/ undefined");
		expect(temporary.evaluateArgs).toEqual([[{ name: "k", value: "v" }]]);
		expect(temporary.calls.at(-1)).toBe("close []");
		expect(result.result).toBe("Loaded 1 cookies, 1 origins with localStorage.");
	});

	test("notes that IndexedDB is not restored", async () => {
		const file = path.join(scratch.dir, "s.json");
		writeFileSync(file, JSON.stringify({ cookies: [], origins: [{ origin: "https://a.test", indexedDB: [{}] }] }));
		const { ctx } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, file));
		expect(result.result).toContain("IndexedDB was not restored.");
	});

	test("reports a file that is missing", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, path.join(scratch.dir, "no.json")))).rejects.toThrow("File not found");
	});
});

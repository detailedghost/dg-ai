import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import handler from "../../../../src/pw/commands/state-save/run";
import spec from "../../../../src/pw/commands/state-save/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("state-save", () => {
	test("writes cookies and origins to the file with mode 0600", async () => {
		const { ctx, context } = fakeCtx(scratch.dir);
		context.returns["storageState"] = { cookies: [{ name: "a" }], origins: [] };
		const file = path.join(scratch.dir, "s.json");
		const result = await handler(ctx, argsFor(spec, file));
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			cookies: [{ name: "a" }],
			origins: [],
		});
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(result.result).toBe(`- [Storage state](${file})`);
	});

	test("tightens an existing world-readable file to 0600", async () => {
		const { ctx, context } = fakeCtx(scratch.dir);
		context.returns["storageState"] = { cookies: [], origins: [] };
		const file = path.join(scratch.dir, "s.json");
		writeFileSync(file, "old");
		chmodSync(file, 0o644);
		await handler(ctx, argsFor(spec, file));
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("defaults to a timestamped file in the output directory and asks for IndexedDB", async () => {
		const { ctx, page, context } = fakeCtx(scratch.dir);
		context.returns["storageState"] = { cookies: [], origins: [] };
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual(['context.storageState [{"indexedDB":true}]']);
		expect(result.result).toMatch(/storage-state-.+\.json\)$/);
	});
});

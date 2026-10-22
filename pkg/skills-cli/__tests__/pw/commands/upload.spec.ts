import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/upload/run";
import spec from "../../../src/pw/commands/upload/spec";

const scratch = useTempScratch();

function chooser() {
	const calls: unknown[] = [];
	return { calls, setFiles: async (files: unknown) => void calls.push(files) };
}

describe("upload", () => {
	test("requires at least one file", () => {
		expect(() => argsFor(spec)).toThrow("Missing argument: <file>");
	});

	test("fails with the fixed message when no file chooser is pending", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "/tmp/x.png"))).rejects.toThrow("No file chooser visible");
	});

	test("sets the files as payloads with their mime types, from any absolute path", async () => {
		const png = path.join(scratch.dir, "x.png");
		const pdf = path.join(scratch.dir, "y.pdf");
		writeFileSync(png, "png-bytes");
		writeFileSync(pdf, "pdf-bytes");
		const pending = chooser();
		const { ctx } = fakeCtx(scratch.dir, undefined, {
			hasChooser: () => true,
			takeChooser: () => pending as never,
		});
		const result = await handler(ctx, argsFor(spec, png, pdf));
		const [files] = pending.calls as [{ name: string; mimeType: string; buffer: Buffer }[]];
		expect(files.map((file) => [file.name, file.mimeType, file.buffer.toString()])).toEqual([
			["x.png", "image/png", "png-bytes"],
			["y.pdf", "application/pdf", "pdf-bytes"],
		]);
		expect(result.snapshot).toBe(true);
	});

	test("resolves a relative path against the client directory", async () => {
		mkdirSync(path.join(scratch.dir, "work"));
		writeFileSync(path.join(scratch.dir, "work", "a.txt"), "hi");
		const pending = chooser();
		const { ctx } = fakeCtx(scratch.dir, undefined, { hasChooser: () => true, takeChooser: () => pending as never });
		ctx.clientCwd = path.join(scratch.dir, "work");
		await handler(ctx, argsFor(spec, "a.txt"));
		expect((pending.calls[0] as { name: string }[])[0]?.name).toBe("a.txt");
	});

	test("names a missing path and keeps the chooser pending", async () => {
		let taken = false;
		const { ctx } = fakeCtx(scratch.dir, undefined, {
			hasChooser: () => true,
			takeChooser: () => {
				taken = true;
				return chooser() as never;
			},
		});
		const missing = path.join(scratch.dir, "nope.png");
		await expect(handler(ctx, argsFor(spec, missing))).rejects.toThrow(`File not found: ${missing}`);
		expect(taken).toBe(false);
	});
});

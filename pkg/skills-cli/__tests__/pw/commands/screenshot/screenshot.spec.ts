import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import handler, { imageType } from "../../../../src/pw/commands/screenshot/run";
import spec from "../../../../src/pw/commands/screenshot/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("imageType", () => {
	test("picks jpeg for jpg and jpeg names and png otherwise", () => {
		expect(imageType("a.jpg")).toBe("jpeg");
		expect(imageType("a.JPEG")).toBe("jpeg");
		expect(imageType("a.png")).toBe("png");
		expect(imageType("a")).toBe("png");
	});
});

describe("screenshot handler", () => {
	test("saves a timestamped png of the viewport in the output directory", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual(["screenshot png fullPage=false"]);
		const [, file] = /\((.+)\)/.exec(String(result.result)) ?? [];
		expect(path.dirname(file as string)).toBe(scratch.dir);
		expect(existsSync(file as string)).toBe(true);
		expect(result.result).toContain("Screenshot of viewport");
	});

	test("takes the full page when asked", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(
			ctx,
			argsFor(spec, "--full-page", "--filename=full.png"),
		);
		expect(page.calls).toEqual(["screenshot png fullPage=true"]);
		expect(result.result).toBe(
			`- [Screenshot of full page](${path.join(scratch.dir, "full.png")})`,
		);
		expect(result.code).toBe(
			`await page.screenshot({ path: ${JSON.stringify(path.join(scratch.dir, "full.png"))}, type: "png", fullPage: true });`,
		);
	});

	test("prints code that writes the viewport to the same file and type", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "--filename=view"));
		expect(result.code).toBe(
			`await page.screenshot({ path: ${JSON.stringify(path.join(scratch.dir, "view"))}, type: "png" });`,
		);
	});

	test("keeps an absolute filename where it is", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		const target = path.join(scratch.dir, "elsewhere", "x.jpg");
		await handler(ctx, argsFor(spec, `--filename=${target}`));
		expect(existsSync(target)).toBe(true);
	});

	test("screenshots one element when a target is given", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(
			ctx,
			argsFor(spec, "e7", "--filename=btn.jpg"),
		);
		expect(page.locator("aria-ref=e7").calls).toEqual(["screenshot jpeg"]);
		expect(result.result).toContain("Screenshot of element");
		expect(result.code).toEndWith(
			`.screenshot({ path: ${JSON.stringify(path.join(scratch.dir, "btn.jpg"))}, type: "jpeg" });`,
		);
	});
});

describe("screenshot permissions", () => {
	test.each([[[]], [["e7"]]])(
		"never writes into an existing shared file (%j)",
		async (target) => {
			const file = path.join(scratch.dir, "shared", "s.png");
			mkdirSync(path.dirname(file), { recursive: true });
			rmSync(path.join(scratch.dir, "shared", "seen.png"), { force: true });
			writeFileSync(file, "old");
			chmodSync(file, 0o644);
			linkSync(file, path.join(scratch.dir, "shared", "seen.png"));
			const { ctx } = fakeCtx(scratch.dir);
			await handler(
				ctx,
				argsFor(spec, ...(target as string[]), `--filename=${file}`),
			);
			expect(
				readFileSync(path.join(scratch.dir, "shared", "seen.png"), "utf8"),
			).toBe("old");
			expect(statSync(file).mode & 0o777).toBe(0o600);
		},
	);

	test("restricts the written file to 0600", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "--filename=private.png"));
		expect(statSync(path.join(scratch.dir, "private.png")).mode & 0o777).toBe(
			0o600,
		);
	});
});

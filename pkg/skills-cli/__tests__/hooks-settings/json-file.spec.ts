import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { updateJsonFile } from "../../src/hooks/settings/json-file";
import { settingsWorld } from "./settings-fixtures";

let world: ReturnType<typeof settingsWorld>;
beforeEach(() => {
	world = settingsWorld();
});
afterEach(() => world.cleanup());

describe("updateJsonFile", () => {
	test("a change made between read and write is re-read and kept in the write", async () => {
		const file = world.seed(world.paths.claude, { theme: "dark" });
		let injected = false;
		await updateJsonFile(file, (doc) => ({ ...doc, dg: true }), {
			afterRead: () => {
				if (injected) return;
				injected = true;
				writeFileSync(file, JSON.stringify({ theme: "dark", concurrent: 1 }));
			},
		});
		expect(world.readJson(file)).toEqual({
			theme: "dark",
			concurrent: 1,
			dg: true,
		});
	});

	test("writes 2-space JSON and leaves no temp file behind", async () => {
		const file = world.seed(world.paths.claude, {});
		await updateJsonFile(file, () => ({ a: { b: 1 } }));
		expect(readFileSync(file, "utf8").trimEnd()).toBe(
			JSON.stringify({ a: { b: 1 } }, null, 2),
		);
		expect(readdirSync(dirname(file))).toEqual(["settings.json"]);
	});

	test("invalid JSON rejects and leaves the file bytes untouched", async () => {
		const file = world.seed(world.paths.claude, "{ not json");
		await expect(updateJsonFile(file, (d) => d)).rejects.toThrow();
		expect(readFileSync(file, "utf8")).toBe("{ not json");
		expect(readdirSync(join(world.home, ".claude"))).toEqual(["settings.json"]);
	});

	test("gives up after three attempts when the file keeps changing", async () => {
		const file = world.seed(world.paths.claude, { n: 0 });
		let writes = 0;
		await expect(
			updateJsonFile(file, (doc) => doc, {
				afterRead: () => writeFileSync(file, JSON.stringify({ n: ++writes })),
			}),
		).rejects.toThrow(`${file} kept changing; try again`);
		expect(writes).toBe(3);
		expect(world.readJson(file)).toEqual({ n: 3 });
	});

	test.skipIf(process.platform === "win32")(
		"keeps mode 0600 on an existing file",
		async () => {
			const file = world.seed(world.paths.claude, { a: 1 });
			chmodSync(file, 0o600);
			await updateJsonFile(file, (doc) => ({ ...doc, b: 2 }));
			expect(lstatSync(file).mode & 0o777).toBe(0o600);
			expect(world.readJson(file)).toEqual({ a: 1, b: 2 });
		},
	);

	test.skipIf(process.platform === "win32")(
		"creates a new file with mode 0600",
		async () => {
			await updateJsonFile(world.paths.claude, () => ({ a: 1 }));
			expect(statSync(world.paths.claude).mode & 0o777).toBe(0o600);
		},
	);

	test.skipIf(process.platform === "win32")(
		"writes through a symlink and keeps the link, the target mode and the target",
		async () => {
			const target = world.seed(
				join(world.dgHome, "dotfiles", "settings.json"),
				{
					theme: "dark",
				},
			);
			chmodSync(target, 0o600);
			const link = join(world.home, ".claude", "settings.json");
			world.seed(join(world.home, ".claude", "keep"), "");
			symlinkSync(target, link);
			await updateJsonFile(link, (doc) => ({ ...doc, a: 1 }));
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(world.readJson(target)).toEqual({ theme: "dark", a: 1 });
			expect(statSync(target).mode & 0o777).toBe(0o600);
		},
	);

	test("skips the write and creates no file when nothing changes", async () => {
		await updateJsonFile(world.paths.claude, (doc) => doc);
		expect(world.has(world.paths.claude)).toBe(false);
	});
});

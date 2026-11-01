import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import baseline from "./fixtures/manifest-permissions.json";

const EXT = resolve(import.meta.dir, "..");

describe("wxt build", () => {
	it("succeeds and keeps the chrome-mv3 permissions unchanged", async () => {
		const build = Bun.spawn([process.execPath, "run", "wxt", "build"], {
			cwd: EXT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err] = await Promise.all([
			new Response(build.stdout).text(),
			new Response(build.stderr).text(),
		]);
		expect(await build.exited, out + err).toBe(0);

		const manifest = JSON.parse(
			readFileSync(
				resolve(EXT, ".output", "chrome-mv3", "manifest.json"),
				"utf8",
			),
		) as { permissions: string[]; host_permissions: string[] };

		expect([...manifest.permissions].sort()).toEqual(
			[...baseline.permissions].sort(),
		);
		expect([...manifest.host_permissions].sort()).toEqual(
			[...baseline.host_permissions].sort(),
		);
	}, 120_000);
});

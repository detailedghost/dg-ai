import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { start } from "../src/daemon";
import type { ChildLike } from "../src/daemon";
import { type DaemonHarness, createDaemonHarness, createFakeChild } from "./daemon-harness";

const posix = describe.skipIf(process.platform === "win32");

const harnesses: DaemonHarness[] = [];

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

posix("start while the legacy channel-review folder is unmoved", () => {
	test("creates no channel-review folder or log and spawns nothing", async () => {
		const h = createDaemonHarness();
		harnesses.push(h);
		const paths = h.pathsFor("dev");
		const target = dirname(paths.pidPath);
		rmSync(target, { recursive: true, force: true });
		mkdirSync(join(paths.dg.legacyHome, "channel-review"), { recursive: true });
		writeFileSync(join(paths.dg.legacyHome, "channel-review", "state.dev.json"), "{}");
		let spawned = 0;
		const spawn = (): ChildLike => {
			spawned += 1;
			return createFakeChild(5551);
		};

		const attempt = start(
			{},
			{ platform: h.platform, system: h.system, io: h.io, which: () => "/usr/bin/aws", spawn, argv: ["/usr/bin/bun", import.meta.path] },
		);

		await expect(attempt).rejects.toBeInstanceOf(DgCliError);
		expect(spawned).toBe(0);
		expect(existsSync(target)).toBe(false);
	});
});

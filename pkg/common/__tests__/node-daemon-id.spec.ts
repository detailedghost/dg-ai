import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonIdPath, ensureDaemonId } from "../src/node/daemon-id";
import { resolveDgPaths } from "../src/node/dg-paths";

const homes: string[] = [];

function freshPaths() {
	const home = mkdtempSync(join(tmpdir(), "dg-daemon-id-"));
	homes.push(home);
	return { home, paths: resolveDgPaths({ env: { DG_HOME: home } }) };
}

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("ensureDaemonId", () => {
	it("creates a private id file once and returns the same id afterwards", () => {
		const { paths } = freshPaths();

		const first = ensureDaemonId(paths);

		expect(first.length).toBeGreaterThan(0);
		expect(ensureDaemonId(paths)).toBe(first);
		expect(readFileSync(daemonIdPath(paths), "utf8").trim()).toBe(first);
		expect(statSync(daemonIdPath(paths)).mode & 0o777).toBe(0o600);
	});

	it("gives every concurrent first start the same id", async () => {
		const { home, paths } = freshPaths();
		const script = `
			import { ensureDaemonId } from ${JSON.stringify(join(import.meta.dir, "../src/node/daemon-id"))};
			import { resolveDgPaths } from ${JSON.stringify(join(import.meta.dir, "../src/node/dg-paths"))};
			process.stdout.write(ensureDaemonId(resolveDgPaths({ env: { DG_HOME: process.env.DG_HOME } })));
		`;
		const runs = Array.from({ length: 8 }, () =>
			Bun.spawn(["bun", "-e", script], {
				env: { ...process.env, DG_HOME: home },
				stdout: "pipe",
			}),
		);

		const ids = await Promise.all(runs.map((run) => new Response(run.stdout).text()));

		expect(new Set(ids).size).toBe(1);
		expect(readFileSync(daemonIdPath(paths), "utf8").trim()).toBe(ids[0]);
	});
});

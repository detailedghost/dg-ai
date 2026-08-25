import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, runInHarness } from "./test-support";

describe("fetchCliBinary overwrites a binary that is currently running", () => {
	test("replacing a busy Linux executable does not throw ETXTBSY", async () => {
		const home = mkdtempSync(join(tmpdir(), "dg-fetch-busy-"));
		const binDir = join(home, ".dg", "bin");
		mkdirSync(binDir, { recursive: true });
		const dest = join(binDir, "dg-busy-test");
		copyFileSync("/bin/sleep", dest);
		chmodSync(dest, 0o755);

		const marker = "new-binary-payload-marker";
		const server = Bun.serve({ port: 0, fetch: () => new Response(marker) });
		const running = Bun.spawn([dest, "5"], {
			stdout: "ignore",
			stderr: "ignore",
		});

		try {
			const libPath = join(
				REPO_ROOT,
				"pkg",
				"skills-cli",
				"src",
				"utils",
				"lib.ts",
			);
			const harness = `
const mod = await import(${JSON.stringify(libPath)});
const asset = {
	name: "dg-busy-test",
	url: ${JSON.stringify(`http://127.0.0.1:${server.port}`)},
	version: "9.9.9",
};
await mod.fetchCliBinary("dg-busy-test", asset);
console.log("DONE");
`;
			const { code, stdout, stderr } = await runInHarness(harness, {
				HOME: home,
			});

			expect(stderr).toBe("");
			expect(code).toBe(0);
			expect(stdout).toContain("DONE");
			expect(readFileSync(dest, "utf8")).toBe(marker);
			expect(existsSync(join(binDir, ".dg-busy-test.version"))).toBe(true);
		} finally {
			running.kill();
			await running.exited;
			server.stop(true);
		}
	});
});

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "./bundle-fixtures";

setDefaultTimeout(60_000);

function environOf(pid: number): string[] {
	try {
		return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
	} catch {
		return [];
	}
}

async function envWhileRunning(args: string[], extra: Record<string, string> = {}): Promise<string[]> {
	const { bun, entry } = buildBundle();
	const home = mkdtempSync(join(tmpdir(), "dg-jit-"));
	dirs.push(home);
	const child = Bun.spawn([bun, entry, ...args], {
		env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), DG_HOME: join(home, "dg"), DG_PATH_FENCE: home, DG_KEY_SOURCE: "file", DG_PORT: "47391", ...extra },
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const env = environOf(child.pid);
			if (env.some((line) => line.startsWith("DG_HOME="))) {
				await Bun.sleep(500);
				return environOf(child.pid);
			}
			await Bun.sleep(50);
		}
		return [];
	} finally {
		child.kill();
		await child.exited;
	}
}

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.if(process.platform === "linux")("long-running processes run without the JIT", () => {
	test("dg daemon serve re-executes itself with BUN_JSC_useJIT=0", async () => {
		expect(await envWhileRunning(["daemon", "serve"])).toContain("BUN_JSC_useJIT=0");
	});

	test("the dg-daemon bridge form of serve re-executes too", async () => {
		expect(await envWhileRunning(["dg-daemon", "serve"])).toContain("BUN_JSC_useJIT=0");
	});

	test("a BUN_JSC_useJIT the caller set is kept, so the JIT can be turned back on", async () => {
		expect(await envWhileRunning(["daemon", "serve"], { BUN_JSC_useJIT: "1" })).toContain("BUN_JSC_useJIT=1");
	});
});

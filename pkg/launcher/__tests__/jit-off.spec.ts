import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "./bundle-fixtures";

setDefaultTimeout(60_000);

const READY_TIMEOUT_MS = 15_000;
const POLL_MS = 50;
const JIT_ENV = "BUN_JSC_useJIT";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function environOf(pid: number): string[] | undefined {
	try {
		return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
	} catch {
		return undefined;
	}
}

function freePort(): Promise<number> {
	return new Promise((done) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => done(port));
		});
	});
}

/** Polls the running process until its environment names BUN_JSC_useJIT. */
async function envAfterStart(args: string[], jit?: string): Promise<string[]> {
	const { bun, entry } = buildBundle();
	const home = mkdtempSync(join(tmpdir(), "dg-jit-"));
	dirs.push(home);
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_STATE_HOME: join(home, "state"),
		DG_HOME: join(home, "dg"),
		DG_PATH_FENCE: home,
		DG_KEY_SOURCE: "file",
		DG_PORT: String(await freePort()),
	};
	delete env[JIT_ENV];
	if (jit !== undefined) env[JIT_ENV] = jit;
	const child = Bun.spawn([bun, entry, ...args], { env, stdout: "ignore", stderr: "ignore" });
	try {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const seen = environOf(child.pid);
			if (seen === undefined) throw new Error(`dg ${args.join(" ")} (pid ${child.pid}) exited before it set ${JIT_ENV}`);
			if (seen.some((line) => line.startsWith(`${JIT_ENV}=`))) return seen;
			await Bun.sleep(POLL_MS);
		}
		throw new Error(`dg ${args.join(" ")} (pid ${child.pid}) did not set ${JIT_ENV} within ${READY_TIMEOUT_MS} ms`);
	} finally {
		child.kill();
		await child.exited;
	}
}

describe.if(process.platform === "linux")("long-running processes run without the JIT", () => {
	test("dg daemon serve re-executes itself with BUN_JSC_useJIT=0", async () => {
		expect(await envAfterStart(["daemon", "serve"])).toContain(`${JIT_ENV}=0`);
	});

	test("the dg-daemon bridge form of serve re-executes too", async () => {
		expect(await envAfterStart(["dg-daemon", "serve"])).toContain(`${JIT_ENV}=0`);
	});

	test("a BUN_JSC_useJIT the caller set is not replaced by 0", async () => {
		const env = await envAfterStart(["daemon", "serve"], "1");
		expect(env).toContain(`${JIT_ENV}=1`);
		expect(env).not.toContain(`${JIT_ENV}=0`);
	});
});

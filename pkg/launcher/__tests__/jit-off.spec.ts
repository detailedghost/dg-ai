import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reexecWithoutJit } from "../src/dispatch";
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
			if (seen === undefined || child.exitCode !== null) throw new Error(`dg ${args.join(" ")} (pid ${child.pid}) exited before it set ${JIT_ENV}`);
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
});

describe("reexecWithoutJit", () => {
	type Call = { file: string; args: string[]; env: Record<string, string | undefined> };

	function recorder(): { calls: Call[]; execve: (file: string, args: string[], env: Record<string, string | undefined>) => void } {
		const calls: Call[] = [];
		return { calls, execve: (file, args, env) => calls.push({ file, args, env }) };
	}

	test("re-executes dg agent phone listen with the JIT off and a marker", async () => {
		const { calls, execve } = recorder();
		await reexecWithoutJit("dg", ["agent", "phone", "listen"], ["agent", "phone", "listen"], { PATH: "/bin" }, execve);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.env).toMatchObject({ PATH: "/bin", [JIT_ENV]: "0", DG_JIT_REEXEC: "1" });
		expect(calls[0]?.args.slice(-3)).toEqual(["agent", "phone", "listen"]);
	});

	test("maps the dg-agent bridge to its agent mount", async () => {
		const { calls, execve } = recorder();
		await reexecWithoutJit("dg-agent", ["phone", "listen"], ["dg-agent", "phone", "listen"], {}, execve);
		expect(calls).toHaveLength(1);
	});

	test("leaves a short command alone", async () => {
		const { calls, execve } = recorder();
		await reexecWithoutJit("dg", ["phone", "status"], ["phone", "status"], {}, execve);
		expect(calls).toHaveLength(0);
	});

	test("keeps a BUN_JSC_useJIT the caller set and does not re-execute", async () => {
		const { calls, execve } = recorder();
		const env = { [JIT_ENV]: "1" };
		await reexecWithoutJit("dg", ["daemon", "serve"], ["daemon", "serve"], env, execve);
		expect(calls).toHaveLength(0);
		expect(env).toEqual({ [JIT_ENV]: "1" });
	});

	test("the re-executed process drops the variable and the marker, so its children keep their JIT", async () => {
		const { calls, execve } = recorder();
		const env: Record<string, string | undefined> = { [JIT_ENV]: "0", DG_JIT_REEXEC: "1", PATH: "/bin" };
		await reexecWithoutJit("dg", ["daemon", "serve"], ["daemon", "serve"], env, execve);
		expect(calls).toHaveLength(0);
		expect(env).toEqual({ PATH: "/bin" });
	});

	test("a marker without BUN_JSC_useJIT=0 does not remove a value the caller set", async () => {
		const env: Record<string, string | undefined> = { [JIT_ENV]: "1", DG_JIT_REEXEC: "1" };
		await reexecWithoutJit("dg", ["daemon", "serve"], ["daemon", "serve"], env, recorder().execve);
		expect(env[JIT_ENV]).toBe("1");
	});

	test("an execve that throws leaves the command running with the JIT", async () => {
		const execve = () => {
			throw new Error("no exec");
		};
		await expect(reexecWithoutJit("dg", ["daemon", "serve"], ["daemon", "serve"], {}, execve)).resolves.toBeUndefined();
	});
});

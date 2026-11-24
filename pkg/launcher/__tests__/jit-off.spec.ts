import { afterAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
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

describe.if(process.platform === "linux")("dg processes run without the JIT", () => {
	test("dg daemon serve re-executes itself with BUN_JSC_useJIT=0", async () => {
		expect(await envAfterStart(["daemon", "serve"])).toContain(`${JIT_ENV}=0`);
	});

	test("the dg-daemon bridge form of serve re-executes too", async () => {
		expect(await envAfterStart(["dg-daemon", "serve"])).toContain(`${JIT_ENV}=0`);
	});
});

describe("reexecWithoutJit", () => {
	type Env = Record<string, string | undefined>;
	type Call = { file: string; args: string[]; env: Env };

	function recorder(): { calls: Call[]; execve: (file: string, args: string[], env: Env) => void } {
		const calls: Call[] = [];
		return { calls, execve: (file, args, env) => calls.push({ file, args, env }) };
	}

	test.each([
		[["phone", "status"]],
		[["hooks", "run", "spelling"]],
		[["--version"]],
		[["dg-agent", "phone", "listen"]],
		[["daemon", "serve"]],
	])("re-executes dg %p with the JIT off and a marker", async (argv) => {
		const { calls, execve } = recorder();
		await reexecWithoutJit(argv, { PATH: "/bin" }, execve);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.env).toMatchObject({ PATH: "/bin", [JIT_ENV]: "0", DG_JIT_REEXEC: "1" });
		expect(calls[0]?.args.slice(-argv.length)).toEqual(argv);
	});

	test.each([
		[["jot", "kick"]],
		[["skills", "jot", "kick-take", "x"]],
		[["stat", "add", "task"]],
		[["dg-skills", "stat", "done", "task"]],
		[["install"]],
		[["update"]],
		[["upgrade"]],
		[["extension"]],
	])("keeps the JIT for dg %p, which needs bun:ffi", async (argv) => {
		const { calls, execve } = recorder();
		await reexecWithoutJit(argv, {}, execve);
		expect(calls).toHaveLength(0);
	});

	test("DG_JIT=1 keeps the JIT for a heavy one-off run", async () => {
		const { calls, execve } = recorder();
		await reexecWithoutJit(["adr", "lint", "--all"], { DG_JIT: "1" }, execve);
		expect(calls).toHaveLength(0);
	});

	test("keeps a BUN_JSC_useJIT the caller set and does not re-execute", async () => {
		const { calls, execve } = recorder();
		const env = { [JIT_ENV]: "1" };
		await reexecWithoutJit(["daemon", "serve"], env, execve);
		expect(calls).toHaveLength(0);
		expect(env).toEqual({ [JIT_ENV]: "1" });
	});

	test("the re-executed process drops the variable and the marker, so its children keep their JIT", async () => {
		const { calls, execve } = recorder();
		const env: Env = { [JIT_ENV]: "0", DG_JIT_REEXEC: "1", PATH: "/bin" };
		await reexecWithoutJit(["pw", "open"], env, execve);
		expect(calls).toHaveLength(0);
		expect(env).toEqual({ PATH: "/bin" });
	});

	test("a marker without BUN_JSC_useJIT=0 does not remove a value the caller set", async () => {
		const env: Env = { [JIT_ENV]: "1", DG_JIT_REEXEC: "1" };
		await reexecWithoutJit(["daemon", "serve"], env, recorder().execve);
		expect(env[JIT_ENV]).toBe("1");
	});

	test("an execve that throws says so and leaves the command running with the JIT", async () => {
		const execve = () => {
			throw new Error("no exec");
		};
		const write = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			await expect(reexecWithoutJit(["daemon", "serve"], {}, execve)).resolves.toBeUndefined();
			expect(String(write.mock.calls[0]?.[0])).toContain("could not restart without the JIT, so it stays on: no exec");
		} finally {
			write.mockRestore();
		}
	});
});

describe("the re-exec call site", () => {
	const source = (file: string) => readFileSync(join(import.meta.dir, "..", "src", file), "utf8");

	test("only the dg entry re-executes, so callers of dispatch keep their own process", () => {
		expect(source("dg.ts")).toContain("await reexecWithoutJit(process.argv.slice(2));");
		expect(source("dispatch.ts")).not.toMatch(/await reexecWithoutJit\(/);
	});
});

describe("bun:ffi needs the JIT", () => {
	test("every module that imports bun:ffi is reached only by a command in FFI_COMMANDS", () => {
		const root = join(import.meta.dir, "..", "..");
		const found = [...new Bun.Glob("*/src/**/*.ts").scanSync({ cwd: root })]
			.filter((file) => /from "bun:ffi"|require\("bun:ffi"\)/.test(readFileSync(join(root, file), "utf8")))
			.sort();
		expect(found).toEqual(["common/src/node/file-lock.ts", "common/src/node/page-cache.ts"]);
	});
});

/**
 * Integration-level smoke for `prototype ui`/`prototype serve`: these self-
 * dispatch the compiled binary (see `selfCommand` in @dg/common/node), which
 * only resolves correctly against the real CLI entrypoint — so, unlike the
 * domain-level unit specs under __tests__/prototype/, this suite drives the
 * real source entrypoint as a subprocess, the same way cli-smoke.spec.ts does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

const cleanupDirs: string[] = [];
const liveServerPids: number[] = [];

afterEach(() => {
	for (const pid of liveServerPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already exited
		}
	}
	for (const dir of cleanupDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function freshDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

function runCli(
	args: string[],
	opts: { cwd: string; env?: Record<string, string> },
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", ENTRY, ...args], {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...opts.env },
	});
	return Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]).then(([out, err, code]) => ({ code, out, err }));
}

let portCounter = 6100;
function nextPort(): number {
	portCounter += 7;
	return portCounter;
}

function trackServerPid(scratch: string, name: string): void {
	const statePath = join(scratch, "prototype-ui", `${name}.json`);
	if (!existsSync(statePath)) return;
	try {
		const state = JSON.parse(readFileSync(statePath, "utf8")) as { pid?: number };
		if (typeof state.pid === "number") liveServerPids.push(state.pid);
	} catch {
		// malformed state file — nothing to track
	}
}

async function waitForServer(port: number, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		try {
			await fetch(`http://127.0.0.1:${port}/prototype-reload`);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	throw new Error(`server on port ${port} never came up within ${deadlineMs}ms`);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilDead(pid: number, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (isPidAlive(pid)) {
		if (Date.now() >= deadline) throw new Error(`pid ${pid} is still alive after ${deadlineMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe("prototype ui — end to end", () => {
	test("renders, serves, and reports a browser confirmation", async () => {
		const scratch = freshDir("proto-ui-e2e-scratch-");
		const ambientCwd = freshDir("proto-ui-e2e-cwd-");
		const name = "e2e-confirm";
		const manifestPath = join(scratch, "manifest.md");
		writeFileSync(
			manifestPath,
			["---", `name: ${name}`, "---", "<p>Hello from the e2e manifest.</p>"].join("\n"),
		);
		const port = nextPort();

		const run = runCli(
			["prototype", "ui", manifestPath, "--light", `--port=${port}`, "--timeout=10", "--no-open"],
			{ cwd: ambientCwd, env: { AI_SCRATCH_DIR: scratch } },
		);

		// Wait for the self-dispatched server to bind, then confirm over HTTP
		// exactly as the browser decision bar would.
		await waitForServer(port, 10_000);
		trackServerPid(scratch, name);
		const confirmRes = await fetch(`http://127.0.0.1:${port}/prototype-decision`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, action: "confirm", variant: "A", notes: "" }),
		});
		expect(confirmRes.status).toBe(200);

		const statePath = join(scratch, "prototype-ui", `${name}.json`);
		const htmlPath = join(scratch, "prototype-ui", `${name}.html`);
		const { pid } = JSON.parse(readFileSync(statePath, "utf8")) as { pid: number };

		const { code, out } = await run;
		expect(code).toBe(0);
		expect(JSON.parse(out.trim())).toEqual({ status: "ok", variant: "A", notes: "" });

		expect(existsSync(statePath)).toBe(false);
		expect(existsSync(htmlPath)).toBe(false);
		await waitUntilDead(pid, 5_000);
	}, 15_000);

	test("genuinely times out (exit 1) when no decision is ever made", async () => {
		const scratch = freshDir("proto-ui-timeout-scratch-");
		const ambientCwd = freshDir("proto-ui-timeout-cwd-");
		const name = "e2e-timeout";
		const manifestPath = join(scratch, "manifest.md");
		writeFileSync(manifestPath, ["---", `name: ${name}`, "---", "<p>content</p>"].join("\n"));

		const { code, out } = await runCli(
			["prototype", "ui", manifestPath, "--light", `--port=${nextPort()}`, "--timeout=1", "--no-open"],
			{ cwd: ambientCwd, env: { AI_SCRATCH_DIR: scratch } },
		);
		trackServerPid(scratch, name);

		expect(code).toBe(1);
		expect(JSON.parse(out.trim())).toEqual({ status: "timeout" });
	}, 15_000);
});

describe("prototype ui — rework loop", () => {
	test("a second invocation for the same name reuses the running server and bumps the reload token", async () => {
		const scratch = freshDir("proto-ui-rework-scratch-");
		const name = "e2e-rework";
		const env = { AI_SCRATCH_DIR: scratch };
		const port = nextPort();

		const manifestV1 = join(scratch, "v1.md");
		writeFileSync(manifestV1, ["---", `name: ${name}`, "---", "<p>version one</p>"].join("\n"));
		const r1 = await runCli(
			["prototype", "ui", manifestV1, "--light", `--port=${port}`, "--timeout=1", "--no-open"],
			{ cwd: freshDir("proto-ui-rework-cwd1-"), env },
		);
		expect(r1.code).toBe(1);
		trackServerPid(scratch, name);

		const statePath = join(scratch, "prototype-ui", `${name}.json`);
		const state1 = JSON.parse(readFileSync(statePath, "utf8")) as { pid: number };

		const manifestV2 = join(scratch, "v2.md");
		writeFileSync(manifestV2, ["---", `name: ${name}`, "---", "<p>version two, reworked</p>"].join("\n"));
		const r2 = await runCli(
			["prototype", "ui", manifestV2, "--light", `--port=${nextPort()}`, "--timeout=1", "--no-open"],
			{ cwd: freshDir("proto-ui-rework-cwd2-"), env },
		);
		expect(r2.code).toBe(1);

		const state2 = JSON.parse(readFileSync(statePath, "utf8")) as { pid: number };
		expect(state2.pid).toBe(state1.pid);

		const htmlPath = join(scratch, "prototype-ui", `${name}.html`);
		const html = readFileSync(htmlPath, "utf8");
		expect(html).toContain("version two, reworked");
		expect(html).not.toContain("version one");
	}, 20_000);
});

describe("prototype ui wait/status subcommands", () => {
	test("status reports 'no session found' and exits 2 for an unknown name", async () => {
		const { code, err } = await runCli(["prototype", "ui", "status", "unknown-session"], {
			cwd: freshDir("proto-ui-status-unknown-"),
			env: { AI_SCRATCH_DIR: freshDir("proto-ui-status-unknown-scratch-") },
		});
		expect(code).toBe(2);
		expect(err).toContain('no session found for "unknown-session"');
	});

	test("wait reports 'no session found' and exits 2 for an unknown name", async () => {
		const { code, err } = await runCli(["prototype", "ui", "wait", "unknown-session", "--timeout=1"], {
			cwd: freshDir("proto-ui-wait-unknown-"),
			env: { AI_SCRATCH_DIR: freshDir("proto-ui-wait-unknown-scratch-") },
		});
		expect(code).toBe(2);
		expect(err).toContain('no session found for "unknown-session"');
	});
});

describe("prototype dir", () => {
	test("--light prints a path under the scratch root, not .agents", async () => {
		const scratch = freshDir("proto-dir-light-scratch-");
		const { code, out } = await runCli(["prototype", "dir", "dir-smoke-light", "--light"], {
			cwd: freshDir("proto-dir-light-cwd-"),
			env: { AI_SCRATCH_DIR: scratch },
		});
		expect(code).toBe(0);
		const printed = out.trim();
		expect(printed.startsWith(join(scratch, "prototype"))).toBe(true);
		expect(printed.endsWith("/dir-smoke-light")).toBe(true);
		expect(printed).not.toContain(".agents");
	});

	test("durable mode prints <cwd>/.agents/prototype/<name> when nothing exists yet", async () => {
		const cwd = freshDir("proto-dir-durable-cwd-");
		const { code, out } = await runCli(["prototype", "dir", "dir-smoke-durable"], { cwd });
		expect(code).toBe(0);
		expect(out.trim()).toBe(join(cwd, ".agents", "prototype", "dir-smoke-durable"));
	});
});

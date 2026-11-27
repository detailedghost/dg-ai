import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(60_000);

const ENTRY = join(import.meta.dir, "..", "src", "dg.ts");
const PRELOAD = join(import.meta.dir, "load-log-preload.ts");
const READY_TIMEOUT_MS = 20_000;
const LOG_SETTLE_MS = 300;

function freePort(): Promise<number> {
	return new Promise((done) => {
		const server = createServer().listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => done(port));
		});
	});
}

async function healthy(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
			headers: { Host: `127.0.0.1:${port}` },
			signal: AbortSignal.timeout(1_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

let home: string;
let loaded: string[] = [];

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "dg-serve-imports-"));
	const log = join(home, "loaded.log");
	const port = await freePort();
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_STATE_HOME: join(home, "state"),
		XDG_RUNTIME_DIR: join(home, "run"),
		DG_HOME: join(home, "dg"),
		DG_PATH_FENCE: home,
		DG_KEY_SOURCE: "file",
		DG_PORT: String(port),
		DG_JIT: "1",
		DG_LOAD_LOG: log,
	};
	const child = Bun.spawn([process.execPath, "--preload", PRELOAD, ENTRY, "daemon", "serve"], {
		env,
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	try {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (!(await healthy(port))) {
			if (child.exitCode !== null) {
				throw new Error(`dg daemon serve exited ${child.exitCode}: ${await stderr}`);
			}
			if (Date.now() > deadline) {
				throw new Error(`dg daemon serve was not healthy within ${READY_TIMEOUT_MS} ms`);
			}
			await Bun.sleep(100);
		}
		await Bun.sleep(LOG_SETTLE_MS);
	} finally {
		child.kill();
		await child.exited;
	}
	loaded = readFileSync(log, "utf8").split("\n").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("dg daemon serve loads only what an idle daemon runs", () => {
	test("loads the daemon bootstrap, so the load log sees the serve path", () => {
		expect(loaded.some((path) => path.endsWith("/dg-daemon/src/server/bootstrap.ts"))).toBe(true);
	});

	test.each([
		["commander", /\/node_modules\/commander\//],
		["the flat route table", /\/pkg\/dg\/src\/flat\.ts$/],
		["a completion tree", /completion-tree\.json$|\/completion\/tree\.json$/],
		["the completion printer", /\/common\/src\/completion\.ts$/],
		["the daemon CLI commands", /\/dg-daemon\/src\/commands\/(jobs|origin|sessions|service|stop|start)\.ts$/],
		["the chat, board and secret page assets", /\/pages\/dist\//],
	])("does not load %s", (_name, pattern) => {
		expect(loaded.filter((path) => pattern.test(path))).toEqual([]);
	});
});

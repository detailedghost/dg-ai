import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveNarrationAsset } from "../src/demo/narration-assets";
import { runPlayer } from "../src/demo/player-process";
import {
	capturingLaunch,
	fakeRoute,
	isolatedHome,
	releaseFetch,
	routeJob,
	WASM_URL,
	type Fulfilled,
} from "./demo-narration-route-fixtures";

let home: ReturnType<typeof isolatedHome>;
let log: ReturnType<typeof spyOn>;

beforeEach(() => {
	home = isolatedHome();
	log = spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
	log.mockRestore();
	home.restore();
	rmSync(home.dir, { recursive: true, force: true });
});

describe("runPlayer narration asset route handler", () => {
	test("registers a pattern that matches nested and top-level asset urls", async () => {
		let pattern: unknown;
		await runPlayer(routeJob(home.dir), {
			fetch: releaseFetch(),
			launch: capturingLaunch(home.dir, async (route) => {
				pattern = route.pattern;
			}),
		});
		expect(pattern).toBeDefined();
		expect(typeof pattern).toBe("string");
		const glob = new Bun.Glob(pattern as string);
		expect(glob.match(WASM_URL)).toBe(true);
		expect(glob.match("https://dg-demo.local/narration/kokoro.js")).toBe(true);
		expect(glob.match("https://example.test/narration/kokoro.js")).toBe(false);
	});

	test("fulfills a nested wasm request from the verified cache with the wasm content type", async () => {
		const fulfilled: Fulfilled[] = [];
		await runPlayer(routeJob(home.dir), {
			fetch: releaseFetch(),
			launch: capturingLaunch(home.dir, async ({ handler, choose }) => {
				await choose("both");
				const call = fakeRoute(WASM_URL);
				await handler(call.route);
				fulfilled.push(...call.fulfilled);
			}),
		});
		expect(fulfilled).toHaveLength(1);
		expect(fulfilled[0]?.status).toBe(200);
		expect(fulfilled[0]?.headers?.["content-type"]).toBe("application/wasm");
	});

	test("fulfills 404 when the assets cannot be downloaded", async () => {
		const fulfilled: Fulfilled[] = [];
		const offline = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;
		await runPlayer(routeJob(home.dir), {
			fetch: offline,
			launch: capturingLaunch(home.dir, async ({ handler, choose }) => {
				await choose("both");
				const call = fakeRoute(WASM_URL);
				await handler(call.route);
				fulfilled.push(...call.fulfilled);
			}),
		});
		expect(fulfilled.map((entry) => entry.status)).toEqual([404]);
	});

	test("answers 404 and downloads nothing before a voice choice grants narration", async () => {
		const fulfilled: Fulfilled[] = [];
		const fetched: string[] = [];
		const inner = releaseFetch();
		await runPlayer(routeJob(home.dir), {
			fetch: ((input: unknown, init?: RequestInit) => {
				fetched.push(String(input));
				return inner(input as never, init);
			}) as typeof fetch,
			launch: capturingLaunch(home.dir, async ({ handler, choose }) => {
				await choose("captions");
				const call = fakeRoute(WASM_URL);
				await handler(call.route);
				fulfilled.push(...call.fulfilled);
			}),
		});
		expect(fulfilled.map((entry) => entry.status)).toEqual([404]);
		expect(fetched).toEqual([]);
	});
});

describe("serveNarrationAsset", () => {
	let root: string;
	let dir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "dg-serve-asset-"));
		dir = join(root, "assets");
		mkdirSync(join(dir, "ort"), { recursive: true });
		writeFileSync(join(dir, "kokoro.js"), "// kokoro");
		writeFileSync(join(dir, "ort", "a.wasm"), "wasm");
		writeFileSync(join(root, "secret.js"), "secret");
		writeFileSync(join(dir, "x.txt"), "text");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("serves allowlisted files with their content types", () => {
		expect(
			serveNarrationAsset(dir, "/narration/kokoro.js").headers["content-type"],
		).toBe("text/javascript");
		expect(serveNarrationAsset(dir, "/narration/ort/a.wasm").status).toBe(200);
	});

	test.each([
		["encoded parent traversal", "/narration/..%2fsecret.js"],
		["encoded double parent traversal", "/narration/..%2f..%2fetc%2fpasswd.js"],
		["dot-dot segment inside a path", "/narration/ort/%2e%2e/%2e%2e/secret.js"],
		["encoded absolute path", "/narration/%2Fetc%2Fx.js"],
		["lone percent", "/narration/%"],
		["extension outside the allowlist", "/narration/x.txt"],
		["path outside the narration prefix", "/other/kokoro.js"],
	])("returns 404 for %s", (_label, pathname) => {
		expect(serveNarrationAsset(dir, pathname).status).toBe(404);
	});
});

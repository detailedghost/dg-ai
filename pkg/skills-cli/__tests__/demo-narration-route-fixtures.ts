import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import pkg from "../package.json" with { type: "json" };
import type { PlayerJob } from "../src/demo/player-job";
import {
	FIXTURE_ENTRIES,
	narrationZipName,
	sha256,
	storedZip,
} from "./demo-narration-fixtures";

export const START = "https://example.test/";
export const WASM_URL =
	"https://dg-demo.local/narration/ort/ort-wasm-simd-threaded.jsep.wasm";

export type RouteHandler = (route: unknown) => Promise<void>;
export type Fulfilled = {
	status?: number;
	headers?: Record<string, string>;
	body?: unknown;
};

export function releaseFetch(): typeof fetch {
	const name = narrationZipName(pkg.version);
	const zip = storedZip(FIXTURE_ENTRIES);
	const sums = `${sha256(zip)}  ${name}\n`;
	return (async (input: unknown) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.endsWith("SHA256SUMS")) return new Response(sums);
		if (url.endsWith(name)) return new Response(new Blob([zip]));
		return new Response("missing", { status: 404 });
	}) as unknown as typeof fetch;
}

export function isolatedHome(): { dir: string; restore(): void } {
	const dir = mkdtempSync(join(tmpdir(), "dg-narration-route-"));
	const previous = { HOME: process.env.HOME, DG_HOME: process.env.DG_HOME };
	mkdirSync(join(dir, "state"), { recursive: true });
	process.env.HOME = dir;
	process.env.DG_HOME = join(dir, "state");
	resolveDgPaths();
	return {
		dir,
		restore() {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

export function capturingLaunch(
	dir: string,
	onPlay: (route: {
		pattern: unknown;
		handler: RouteHandler;
		choose(narration: string): Promise<unknown>;
	}) => Promise<void>,
) {
	const main = { url: () => START };
	let route: { pattern: unknown; handler: RouteHandler } | undefined;
	let binding: ((source: unknown, msg: unknown) => unknown) | undefined;
	const page = {
		mainFrame: () => main,
		exposeBinding: async (_name: string, cb: typeof binding) => {
			binding = cb;
		},
		addInitScript: async () => undefined,
		route: async (pattern: unknown, handler: RouteHandler) => {
			route = { pattern, handler };
		},
		on: () => undefined,
		evaluate: async () => undefined,
		goto: async () => {
			if (route)
				await onPlay({
					...route,
					choose: async (narration) =>
						binding?.(
							{ frame: main, page },
							{ kind: "choice", mode: "video", narration, voice: "af_heart" },
						),
				});
			await binding?.({ frame: main, page }, { kind: "done" });
		},
		video: () => ({
			path: async () => {
				const file = join(dir, "raw.webm");
				writeFileSync(file, "webm");
				return file;
			},
		}),
	};
	return async () => ({
		context: {
			pages: () => [page],
			newPage: async () => page,
			once: () => undefined,
			close: async () => undefined,
		} as never,
		close: async () => undefined,
	});
}

export const routeJob = (dir: string): PlayerJob => ({
	slug: "routed",
	planPath: join(dir, "routed.demo.md"),
	dir,
	video: true,
	startUrl: START,
	script: {
		title: "Routed",
		startUrl: START,
		steps: [{ title: "One", body: "hello" }],
	},
});

export function fakeRoute(url: string): {
	route: unknown;
	fulfilled: Fulfilled[];
} {
	const fulfilled: Fulfilled[] = [];
	return {
		fulfilled,
		route: {
			request: () => ({ url: () => url }),
			fulfill: async (options: Fulfilled) => {
				fulfilled.push(options);
			},
		},
	};
}

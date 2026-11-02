import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TourScript } from "@dg/common";
import * as realVerify from "../src/utils/demo-verify";
import { tourPageFor, verifyLocal } from "../src/demo/verify-local";

type Overlay = { kind: "none" | "consent" | "step" | "done"; index: number };

function fakePage(script: TourScript, missing: string[] = []) {
	let index = 0;
	let consented = false;
	return {
		async readTourOverlay(): Promise<Overlay> {
			if (!consented) return { kind: "consent", index: 0 };
			if (index >= script.steps.length) return { kind: "done", index };
			return { kind: "step", index };
		},
		async clickThroughTour() {
			if (!consented) consented = true;
			else index++;
			return true;
		},
		async selectorResolves(selector: string) {
			return !missing.includes(selector);
		},
		async locationHref() {
			return script.startUrl;
		},
		drainNavigations(): string[] {
			return [];
		},
	};
}

const script = (): TourScript => ({
	title: "t",
	startUrl: "https://example.test/",
	steps: [
		{ title: "One", body: "a", selector: "#one" },
		{ title: "Two", body: "b", selector: "#two" },
	],
});

describe("walkTour through a local page", () => {
	test("a selector that misses reports selector-unresolved for step 2", async () => {
		const s = script();
		const result = await realVerify.walkTour(fakePage(s, ["#two"]) as never, s);
		expect(result.ok).toBe(false);
		expect(result.findings).toEqual([
			{ step: 2, kind: "selector-unresolved", selector: "#two" },
		]);
	});

	test("a clean plan reports ok true with no findings", async () => {
		const s = script();
		const result = await realVerify.walkTour(fakePage(s) as never, s);
		expect(result).toEqual({ ok: true, findings: [] });
	});
});

const SRC = (file: string) => join(import.meta.dir, "..", "src", file);

async function inSubprocess(body: string): Promise<unknown> {
	const code = `
import { mock } from "bun:test";
import * as real from ${JSON.stringify(SRC("utils/demo-verify.ts"))};
mock.module(${JSON.stringify(SRC("utils/demo-verify.ts"))}, () => ({
  ...real,
  resolveExtensionDir: () => { throw new Error("the extension build must not be required"); },
}));
const { verifyLocal } = await import(${JSON.stringify(SRC("demo/verify-local.ts"))});
${body}
`;
	const child = Bun.spawn([process.execPath, "-e", code], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const line = out.trim().split("\n").at(-1) ?? "";
	try {
		return JSON.parse(line);
	} catch {
		throw new Error(`no JSON result\nstdout: ${out}\nstderr: ${err}`);
	}
}

describe("verifyLocal", () => {
	test("never resolves the extension build and reports the walker's findings", async () => {
		const result = await inSubprocess(`
let index = 0;
let consented = false;
const closed = [];
const page = {
  readTourOverlay: async () => !consented ? { kind: "consent", index: 0 } : index >= 2 ? { kind: "done", index } : { kind: "step", index },
  clickThroughTour: async () => { if (!consented) consented = true; else index++; return true; },
  selectorResolves: async (sel) => sel !== "#two",
  locationHref: async () => "https://example.test/",
  drainNavigations: () => [],
};
const script = { title: "t", startUrl: "https://example.test/", steps: [
  { title: "One", body: "a", selector: "#one" },
  { title: "Two", body: "b", selector: "#two" },
] };
const result = await verifyLocal(script, { open: async () => ({ page, close: async () => void closed.push("closed") }) });
console.log(JSON.stringify({ kinds: result.findings.map((f) => f.kind), closed }));
`);
		expect(result).toEqual({ kinds: ["selector-unresolved"], closed: ["closed"] });
	});

	test("reports ok true for a clean plan", async () => {
		const { verifyLocal } = await import("../src/demo/verify-local");
		const s = script();
		const result = await verifyLocal(s, {
			open: async () => ({ page: fakePage(s) as never, close: async () => {} }),
		});
		expect(result).toEqual({ ok: true, findings: [] });
	});

	test("turns an open failure into a harness-error finding", async () => {
		const { verifyLocal } = await import("../src/demo/verify-local");
		const result = await verifyLocal(script(), {
			open: async () => {
				throw new Error("no browser");
			},
		});
		expect(result).toEqual({
			ok: false,
			findings: [{ step: 0, kind: "harness-error", message: "no browser" }],
		});
	});

	test("closes the session when the walk throws", async () => {
		const { verifyLocal } = await import("../src/demo/verify-local");
		const closed: string[] = [];
		const result = await verifyLocal(script(), {
			open: async () => ({
				page: {
					readTourOverlay: async () => {
						throw new Error("page crashed");
					},
				} as never,
				close: async () => void closed.push("closed"),
			}),
		});
		expect(result.findings[0]?.kind).toBe("harness-error");
		expect(closed).toEqual(["closed"]);
	});
});

describe("local page adapter", () => {
	const adapter = (state: unknown, calls: string[] = []) =>
		tourPageFor(
			{
				evaluate: async (expression) => {
					calls.push(expression);
					return expression.includes("state()") ? JSON.stringify(state) : true;
				},
				url: () => "https://example.test/",
			},
			() => [],
		);

	test("reads the step the player reports", async () => {
		expect(await adapter({ kind: "step", index: 1, total: 2 }).readTourOverlay()).toEqual({
			kind: "step",
			index: 1,
			total: 2,
		});
	});

	test("reads done from the player state, not from a bridge message", async () => {
		expect(await adapter({ kind: "done" }).readTourOverlay()).toEqual({ kind: "done" });
	});

	test("an errored tour throws instead of reading as done", async () => {
		await expect(
			adapter({ kind: "ended", outcome: "error", error: "boom" }).readTourOverlay(),
		).rejects.toThrow("boom");
	});

	test("a stopped tour throws", async () => {
		await expect(
			adapter({ kind: "ended", outcome: "stopped" }).readTourOverlay(),
		).rejects.toThrow("stopped early");
	});

	test("advances through the player, never through page markup", async () => {
		const calls: string[] = [];
		expect(await adapter({ kind: "none" }, calls).clickThroughTour()).toBe(true);
		expect(calls).toEqual(["window.__dgTour ? window.__dgTour.advance() : false"]);
	});
});

describe("verifyLocal with excluded setup", () => {
	test("walks setup and tutorial as one flat sequence", async () => {
		const s: TourScript = {
			...script(),
			setup: {
				includeInTour: false,
				steps: [
					{ title: "S1", body: "a", selector: "#s1" },
					{ title: "S2", body: "b", selector: "#s2" },
				],
			},
		};
		let opened: TourScript | undefined;
		const flat = { ...s, steps: [...s.setup!.steps, ...s.steps] };
		const result = await verifyLocal(s, {
			open: async (given) => {
				opened = given;
				return {
					page: fakePage(flat, ["#two"]) as never,
					close: async () => {},
				};
			},
		});
		expect(opened?.setup?.includeInTour).toBe(true);
		expect(result.findings).toEqual([
			{ step: 4, kind: "selector-unresolved", selector: "#two" },
		]);
	});

	const openedScript = async (s: TourScript): Promise<TourScript | undefined> => {
		let opened: TourScript | undefined;
		await verifyLocal(s, {
			open: async (given) => {
				opened = given;
				throw new Error("stop");
			},
		});
		return opened;
	};

	test("keeps the first tutorial step on the start URL after a setup step moved to another page", async () => {
		const opened = await openedScript({
			...script(),
			setup: {
				includeInTour: false,
				steps: [{ title: "S1", body: "a", navigate: "https://a.test/login" }],
			},
		});
		expect(opened?.setup?.steps[0]?.navigate).toBe("https://a.test/login");
		expect(opened?.steps[0]?.navigate).toBe("https://example.test/");
		expect(opened?.steps[1]?.navigate).toBeUndefined();
	});

	test("leaves a first tutorial step that names its own URL alone", async () => {
		const base = script();
		const opened = await openedScript({
			...base,
			steps: [{ ...base.steps[0]!, navigate: "https://b.test/" }, base.steps[1]!],
			setup: {
				includeInTour: false,
				steps: [{ title: "S1", body: "a", navigate: "https://a.test/login" }],
			},
		});
		expect(opened?.steps[0]?.navigate).toBe("https://b.test/");
	});
});

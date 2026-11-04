import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNNER = join(
	import.meta.dir,
	"../../../plugins/dg/skills/sdlc/references/templates/slice-wave.workflow.js",
);
const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");

const stage = { agentType: "dg:js", model: "sonnet", effort: "medium" };
const body = readFileSync(RUNNER, "utf8").replace(/^export /m, "");

const makeSlice = (extra: Record<string, unknown> = {}) => ({
	id: 1,
	name: "n",
	primary: stage,
	qa: [],
	brief: "",
	testingCriteria: "",
	...extra,
});

async function runRunner(
	args: Record<string, unknown>,
	agent: (prompt: string, options: { label: string }) => Promise<unknown>,
	log: (line: string) => void = () => {},
) {
	const parallel = (jobs: (() => unknown)[]) => Promise.all(jobs.map((job) => job()));
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
	return new AsyncFunction("args", "pipeline", "parallel", "agent", "log", body)(
		args,
		fakePipeline,
		parallel,
		agent,
		log,
	);
}

const fakePipeline = async (
	items: unknown[],
	...steps: ((value: unknown) => unknown)[]
) =>
	Promise.all(
		items.map(async (item) => {
			try {
				let value = item;
				for (const step of steps) value = await step(value);
				return value;
			} catch {
				return null;
			}
		}),
	);

describe("slice-wave runner", () => {
	const text = readFileSync(RUNNER, "utf8");

	test.each(["EFFORT_BY_MODEL", "FABLE_AGENTS", "OPUS_AGENTS", "modelFor"])(
		"does not mention %s",
		(name) => {
			expect(text).not.toContain(name);
		},
	);

	test("holds no tier name as a string literal", () => {
		expect(text).not.toMatch(/(["'`])(haiku|sonnet|opus|fable)\1/);
	});

	test("holds no effort level as a string literal", () => {
		expect(text).not.toMatch(/(["'`])(low|medium|high|xhigh|max)\1/);
	});
});

describe("slice-wave runner correction deferrals", () => {
	async function wave(fixResult: unknown, extra: Record<string, unknown> = {}) {
		const labels: string[] = [];
		const prompts: Record<string, string> = {};
		const agent = async (prompt: string, options: { label: string }) => {
			labels.push(options.label);
			prompts[options.label] = prompt;
			if (options.label.startsWith("red:") || options.label.startsWith("green:"))
				return { testFiles: [], deferrals: [] };
			if (options.label.startsWith("yellow:"))
				return { changedFiles: ["a.ts"], testsPass: true, deferrals: [] };
			if (options.label.startsWith("fix:")) return fixResult;
			return {
				findings: [{ severity: "MEDIUM", file: "a.ts", issue: "x", owner: "engineering" }],
			};
		};
		const args = {
			slices: [makeSlice(extra)],
			roles: { "qa-writer": stage, wave: stage, security: stage },
			templates: { proxy: "go {PROXY_FLAGS} end", correction: "fix" },
		};
		const result = await runRunner(args, agent);
		return { result, labels, prompts };
	}

	test("surfaces a blocking correction deferral and stops the correction loop", async () => {
		const { result, labels } = await wave({
			changedFiles: [],
			testsPass: true,
			deferrals: [{ type: "SPEC", text: "which API shape?" }],
		});
		expect(result.slices[0].status).toBe("blocked");
		expect(result.slices[0].deferrals).toEqual([
			{ type: "SPEC", text: "which API shape?" },
		]);
		expect(labels.filter((label) => label.includes("#1"))).toEqual([
			"fix:engineering:1#1",
		]);
	});

	test("fills {PROXY_FLAGS} in the proxy yellow and correction prompts", async () => {
		const { prompts } = await wave(
			{ changedFiles: [], testsPass: true, deferrals: [] },
			{ proxyBackend: "codex", proxyFlags: "--effort xhigh --tier opus" },
		);
		expect(prompts["yellow:1"]).toBe("go --effort xhigh --tier opus end");
		expect(prompts["fix:engineering:1#1"]).toBe("go --effort xhigh --tier opus end");
	});

	test("keeps a non-blocking correction deferral on the slice result", async () => {
		const { result } = await wave({
			changedFiles: [],
			testsPass: true,
			deferrals: [{ type: "CRITICAL", text: "note" }],
		});
		expect(result.slices[0].status).not.toBe("blocked");
		expect(result.slices[0].deferrals).toContainEqual({ type: "CRITICAL", text: "note" });
	});
});

describe("slice-wave runner deferral handling", () => {
	const quiet = { findings: [] };

	async function wave(
		stages: Record<string, unknown>,
		runnerArgs: Record<string, unknown> = {},
	) {
		const labels: string[] = [];
		const prompts: Record<string, string> = {};
		const agent = async (prompt: string, options: { label: string }) => {
			labels.push(options.label);
			prompts[options.label] = prompt;
			const key = options.label.split(":")[0] as string;
			return key in stages ? stages[key] : quiet;
		};
		const args = {
			slices: [makeSlice()],
			roles: { "qa-writer": stage, wave: stage, security: stage },
			templates: {
				yellow: "yellow:{CHANGED_FILES}",
				wave: "review:{CHANGED_FILES}",
			},
			...runnerArgs,
		};
		const result = await runRunner(args, agent);
		return { slice: result.slices[0], labels, prompts };
	}

	const red = (deferrals: unknown[]) => ({
		testFiles: ["a.test.ts"],
		deferrals,
	});
	const yellow = { changedFiles: ["a.ts"], testsPass: true, deferrals: [] };

	test.each(["SPEC", "TEST"])(
		"blocks the slice after red on a %s deferral",
		async (type) => {
			const { slice, labels } = await wave({ red: red([{ type, text: "q" }]) });
			expect(slice.status).toBe("blocked");
			expect(labels).toEqual(["red:1"]);
		},
	);

	test("does not block on a CONFIRM deferral and keeps it in the result", async () => {
		const confirm = { type: "CONFIRM", text: "changed an assertion" };
		const { slice, labels } = await wave({
			red: red([confirm]),
			yellow: { ...yellow, deferrals: [confirm] },
			green: red([]),
		});
		expect(slice.status).not.toBe("blocked");
		expect(labels).toContain("green:1");
		expect(slice.deferrals).toContainEqual(confirm);
	});

	test("does not block on a deferral whose text starts with a resolved prefix", async () => {
		const { slice } = await wave(
			{
				red: red([{ type: "SPEC", text: "Checkbox ticking: who ticks?" }]),
				yellow,
				green: red([]),
			},
			{ resolved: ["Checkbox ticking"] },
		);
		expect(slice.status).not.toBe("blocked");
	});

	test("still blocks on a deferral that matches no resolved prefix", async () => {
		const { slice } = await wave(
			{ red: red([{ type: "TEST", text: "Other question" }]) },
			{ resolved: ["Checkbox ticking"] },
		);
		expect(slice.status).toBe("blocked");
	});

	test("skips red and feeds the red-done files to yellow", async () => {
		const { labels, prompts } = await wave(
			{ yellow, green: red([]) },
			{ redDone: { 1: ["x.test.ts"] } },
		);
		expect(labels).not.toContain("red:1");
		expect(prompts["yellow:1"]).toBe("yellow:x.test.ts");
	});

	test("runs red for a slice absent from red-done", async () => {
		const { labels } = await wave(
			{ red: red([]), yellow, green: red([]) },
			{ redDone: { 2: ["x.test.ts"] } },
		);
		expect(labels).toContain("red:1");
	});

	test("reviews the union of reported, modified and untracked files", async () => {
		const { prompts, labels } = await wave(
			{
				red: red([]),
				yellow,
				green: red([]),
				files: { ok: true, files: ["a.ts", "missed.ts", "new-untracked.ts"] },
			},
			{ cwd: "/work/tree" },
		);
		expect(labels).toContain("files:1");
		expect(prompts["files:1"]).toContain("/work/tree");
		expect(prompts["files:1"]).toContain("git diff --name-only HEAD");
		expect(prompts["files:1"]).toContain("git ls-files --others --exclude-standard");
		expect(Object.values(prompts).find((p) => p.startsWith("review:"))).toBe(
			"review:a.test.ts\na.ts\nmissed.ts\nnew-untracked.ts",
		);
	});

	test("places a slice's notes in that slice's prompts only", async () => {
		const prompts: string[] = [];
		const two = {
			id: 2,
			name: "m",
			primary: stage,
			qa: [],
			brief: "",
			testingCriteria: "",
		};
		const { prompts: seen } = await wave(
			{ red: red([]), yellow, green: red([]) },
			{
				slices: [{ ...two, id: 1, notes: "SETTLED-ONLY-FOR-ONE" }, two],
				templates: { red: "red", yellow: "y", wave: "w" },
			},
		);
		prompts.push(seen["red:1"] as string, seen["yellow:1"] as string);
		for (const prompt of prompts) expect(prompt).toContain("SETTLED-ONLY-FOR-ONE");
		for (const label of ["red:2", "yellow:2"])
			expect(seen[label]).not.toContain("SETTLED-ONLY-FOR-ONE");
	});

	test("limits recovered git paths to the slice's own file globs", async () => {
		const own = { id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const { prompts } = await wave(
			{
				red: red([]),
				yellow,
				green: red([]),
				files: { ok: true, files: ["src/one/x.ts", "src/two/y.ts", "src/one/deep/z.ts"] },
			},
			{ cwd: "/work/tree", slices: [{ ...own, files: ["src/one/**"] }] },
		);
		const review = Object.values(prompts).find((p) => p.startsWith("review:")) as string;
		expect(review).toContain("src/one/x.ts");
		expect(review).toContain("src/one/deep/z.ts");
		expect(review).not.toContain("src/two/y.ts");
	});

	test("drops yellow-reported paths that fall outside the slice's file globs", async () => {
		const own = { id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const { prompts, slice } = await wave(
			{
				red: red([]),
				yellow: { ...yellow, changedFiles: ["src/one/x.ts", "src/two/y.ts"] },
				green: red([]),
			},
			{ slices: [{ ...own, files: ["src/one/**"] }] },
		);
		const review = Object.values(prompts).find((p) => p.startsWith("review:")) as string;
		expect(review).toContain("src/one/x.ts");
		expect(review).not.toContain("src/two/y.ts");
		expect(slice.changedFiles).not.toContain("src/two/y.ts");
	});

	test("runs red for a slice id that only exists on the object prototype", async () => {
		const own = { id: "constructor", name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const { labels } = await wave(
			{ red: red([]), yellow, green: red([]) },
			{ slices: [own] },
		);
		expect(labels).toContain("red:constructor");
	});

	test("adds owned recovered files to the commit list when the slice declares globs", async () => {
		const own = { id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const { slice } = await wave(
			{
				red: red([]),
				yellow,
				green: red([]),
				files: { ok: true, files: ["src/one/helper.ts", "src/two/y.ts"] },
			},
			{ cwd: "/work/tree", slices: [{ ...own, files: ["src/one/**"] }] },
		);
		expect(slice.changedFiles).toContain("src/one/helper.ts");
		expect(slice.changedFiles).not.toContain("src/two/y.ts");
	});

	test.each([
		["./src/**", "src/helper.ts"],
		["src/*.{ts,tsx}", "src/helper.tsx"],
		["src/[hx]elper.ts", "src/helper.ts"],
		["src/app/\\[slug\\]/page.tsx", "src/app/[slug]/page.tsx"],
	])("matches the glob %s against %s", async (glob, path) => {
		const own = { id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const { prompts } = await wave(
			{ red: red([]), yellow, green: red([]), files: { ok: true, files: [path] } },
			{ cwd: "/work/tree", slices: [{ ...own, files: [glob] }] },
		);
		const review = Object.values(prompts).find((p) => p.startsWith("review:")) as string;
		expect(review).toContain(path);
	});

	test("normalizes dot segments before the ownership check", async () => {
		const own = { id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const { prompts } = await wave(
			{ red: red([]), yellow, green: red([]), files: { ok: true, files: ["src/./a.ts"] } },
			{ cwd: "/work/tree", slices: [{ ...own, files: ["src/**"] }] },
		);
		const review = Object.values(prompts).find((p) => p.startsWith("review:")) as string;
		expect(review).toContain("src/a.ts");
	});

	test("refuses parent-traversal and absolute paths from every list", async () => {
		const own = { id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const bad = ["src/../secrets.txt", "../x.ts", "/etc/passwd", "src/a/../../b.ts"];
		const { prompts, slice } = await wave(
			{
				red: red([]),
				yellow: { ...yellow, changedFiles: ["src/ok.ts", ...bad] },
				green: { ...red([]), testFiles: bad },
				files: { ok: true, files: bad },
			},
			{ cwd: "/work/tree", slices: [{ ...own, files: ["src/**"] }] },
		);
		const review = Object.values(prompts).find((p) => p.startsWith("review:")) as string;
		expect(review).toContain("src/ok.ts");
		for (const path of bad) {
			expect(review).not.toContain(path);
			expect(slice.changedFiles).not.toContain(path);
		}
		expect(slice.changedFiles).not.toContain("secrets.txt");
	});

	test("refuses backslash and drive-letter paths from every list", async () => {
		const own = { id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const bad = ["src\\..\\x.ts", "C:\\win.ts", "c:win.ts", "src\\a\\..\\..\\b.ts"];
		const { prompts, slice } = await wave(
			{
				red: red([]),
				yellow: { ...yellow, changedFiles: ["src/ok.ts", ...bad] },
				green: { ...red([]), testFiles: bad },
				files: { ok: true, files: bad },
			},
			{ cwd: "/work/tree", slices: [{ ...own, files: ["src/**"] }] },
		);
		const review = Object.values(prompts).find((p) => p.startsWith("review:")) as string;
		expect(review).toContain("src/ok.ts");
		for (const path of bad) {
			expect(review).not.toContain(path);
			expect(slice.changedFiles).not.toContain(path);
		}
	});

	test("refuses unsafe red-stage test files from red-done and from red", async () => {
		const bad = ["../evil.test.ts", "/etc/passwd", "src\\..\\x.ts", "C:\\w.ts"];
		const fromDone = await wave(
			{ yellow, green: red([]) },
			{ redDone: { 1: ["ok.test.ts", ...bad] } },
		);
		expect(fromDone.prompts["yellow:1"]).toBe("yellow:ok.test.ts");
		const fromRed = await wave({
			red: { testFiles: ["ok.test.ts", ...bad], deferrals: [] },
			yellow,
			green: red([]),
		});
		expect(fromRed.prompts["yellow:1"]).toBe("yellow:ok.test.ts");
	});

	test("marks the slice unverified and ignores files when a git listing failed", async () => {
		const { slice, prompts } = await wave(
			{ red: red([]), yellow, green: red([]), files: { ok: false, files: ["missed.ts"] } },
			{ cwd: "/work/tree" },
		);
		expect(slice.status).toBe("unverified");
		expect(slice.unverifiedStages).toContain("files");
		const review = Object.values(prompts).find((p) => p.startsWith("review:")) as string;
		expect(review).not.toContain("missed.ts");
	});

	test("asks the file-list agent to report whether both git commands exited 0", async () => {
		const { prompts } = await wave(
			{ red: red([]), yellow, green: red([]), files: { ok: true, files: [] } },
			{ cwd: "/work/tree" },
		);
		expect(prompts["files:1"]).toContain("ok");
		expect(prompts["files:1"]).toContain("exit");
	});

	test("treats [!x] in a glob as a negated class", async () => {
		const own = { id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "" };
		const { prompts } = await wave(
			{ red: red([]), yellow, green: red([]), files: { ok: true, files: ["src/a.ts", "src/b.ts"] } },
			{ cwd: "/work/tree", slices: [{ ...own, files: ["src/[!a].ts"] }] },
		);
		const review = Object.values(prompts).find((p) => p.startsWith("review:")) as string;
		expect(review).toContain("src/b.ts");
		expect(review).not.toContain("src/a.ts");
	});

	test("keeps git-only files out of the slice's commit list", async () => {
		const { slice } = await wave(
			{ red: red([]), yellow, green: red([]), files: { ok: true, files: ["other-slice.ts"] } },
			{ cwd: "/work/tree" },
		);
		expect(slice.changedFiles).toEqual(["a.test.ts", "a.ts"]);
	});

	test("drops a settled SPEC deferral from the returned deferrals", async () => {
		const settledItem = { type: "SPEC", text: "Settled question: again" };
		const confirm = { type: "CONFIRM", text: "Settled question is only prefix for SPEC" };
		const { slice } = await wave(
			{ red: red([settledItem]), yellow: { ...yellow, deferrals: [confirm] }, green: red([]) },
			{ resolved: ["Settled question"] },
		);
		expect(slice.deferrals).toEqual([confirm]);
	});

	test("marks the slice unverified when the file-list stage returns nothing", async () => {
		const { slice } = await wave(
			{ red: red([]), yellow, green: red([]), files: null },
			{ cwd: "/work/tree" },
		);
		expect(slice.status).toBe("unverified");
		expect(slice.unverifiedStages).toContain("files");
	});

	test("skips the file-list stage when no cwd is set", async () => {
		const { labels } = await wave({ red: red([]), yellow, green: red([]) });
		expect(labels).not.toContain("files:1");
	});
});

describe("engineering deferral gate", () => {
	test("pauses only on blocking deferrals, never on CONFIRM", () => {
		const text = readFileSync(join(SKILLS, "sdlc/references/engineering.md"), "utf8");
		expect(text).toContain("1. **Deferrals first.** Any `SPEC`, `TEST` or `CRITICAL` deferral (or `status: blocked`)");
		expect(text).not.toContain("Any `deferrals` (or");
	});
});

const sliceOf = (label: string) => /:([^:#]+)(?:#\d+)?$/.exec(label)?.[1];
const waitFor = async (labels: string[], label: string) => {
	for (let i = 0; i < 200 && !labels.includes(label); i++)
		await new Promise((resolve) => setTimeout(resolve, 0));
};
const heldAt = async (wave: { labels: string[] }, label: string) => {
	await waitFor(wave.labels, label);
	await new Promise((resolve) => setTimeout(resolve, 0));
};

interface GateSlice {
	id: number | string;
	dependsOn?: (number | string)[];
}

interface GateOptions {
	hold?: string;
	script?: (key: string, id: string) => unknown;
	throwFor?: string;
	extra?: Record<string, unknown>;
}

function gateWave(slices: GateSlice[], options: GateOptions = {}) {
	const labels: string[] = [];
	const logs: string[] = [];
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const agent = async (_prompt: string, call: { label: string }) => {
		labels.push(call.label);
		const id = sliceOf(call.label) as string;
		if (id === options.hold) await held;
		if (call.label === options.throwFor) throw new Error("stage died");
		const key = call.label.split(":")[0] as string;
		const scripted = options.script?.(key, id);
		if (scripted !== undefined) return scripted;
		if (key === "red" || key === "green") return { testFiles: [], deferrals: [] };
		if (key === "yellow" || key === "fix")
			return { changedFiles: [], testsPass: true, deferrals: [] };
		return { findings: [] };
	};
	const args = {
		slices: slices.map((slice) => makeSlice({ ...slice })),
		roles: { "qa-writer": stage, wave: stage, security: stage },
		templates: { red: "r", yellow: "y", green: "g", wave: "w", correction: "c" },
		...options.extra,
	};
	const done = runRunner(args, agent, (line) => logs.push(line)) as Promise<{
		slices: {
			sliceId: number | string;
			status: string;
			blockedBy?: unknown[];
			[key: string]: unknown;
		}[];
		droppedSlices: unknown[];
	}>;
	const byId = async (id: number | string) =>
		(await done).slices.find((slice) => String(slice.sliceId) === String(id));
	return { done, labels, logs, release, byId };
}

const lastIndexFor = (labels: string[], id: string) =>
	labels.reduce((last, label, i) => (sliceOf(label) === id ? i : last), -1);

describe("slice-wave runner dependency gate", () => {
	const chain = [{ id: 1, dependsOn: [] }, { id: 2, dependsOn: [1] }];

	test("runs a dependent's red stage only after the dependency's final result", async () => {
		const wave = gateWave(chain, { hold: "1" });
		await heldAt(wave, "red:1");
		expect(wave.labels).toContain("red:1");
		expect(wave.labels).not.toContain("red:2");
		wave.release();
		await wave.done;
		expect(wave.labels.indexOf("red:2")).toBeGreaterThan(lastIndexFor(wave.labels, "1"));
	});

	test("starts independent slices without waiting on each other", async () => {
		const wave = gateWave(
			[{ id: 1, dependsOn: [] }, { id: 2, dependsOn: [1] }, { id: 3, dependsOn: [] }],
			{ hold: "1" },
		);
		await heldAt(wave, "red:3");
		expect(wave.labels).toContain("red:3");
		expect(wave.labels).not.toContain("red:2");
		wave.release();
		await wave.done;
		expect(wave.labels).toContain("red:2");
	});

	test("a re-run slice with redDone still waits for its dependencies", async () => {
		const wave = gateWave(chain, { hold: "1", extra: { redDone: { 2: ["x.test.ts"] } } });
		await heldAt(wave, "red:1");
		expect(wave.labels).not.toContain("yellow:2");
		wave.release();
		await wave.done;
		expect(wave.labels.indexOf("yellow:2")).toBeGreaterThan(lastIndexFor(wave.labels, "1"));
		expect(wave.labels).not.toContain("red:2");
	});

	test("a redDone slice is blocked-upstream when its dependency blocked", async () => {
		const wave = gateWave(chain, {
			script: (key, id) =>
				key === "red" && id === "1"
					? { testFiles: [], deferrals: [{ type: "SPEC", text: "q" }] }
					: undefined,
			extra: { redDone: { 2: ["x.test.ts"] } },
		});
		expect((await wave.byId(2))?.status).toBe("blocked-upstream");
		expect(wave.labels.filter((label) => sliceOf(label) === "2")).toEqual([]);
	});

	test("returns blocked-upstream and runs no agent for a slice behind a blocked dependency", async () => {
		const wave = gateWave(chain, {
			script: (key, id) =>
				key === "red" && id === "1"
					? { testFiles: [], deferrals: [{ type: "SPEC", text: "q" }] }
					: undefined,
		});
		const result = await wave.done;
		expect(result.slices.find((s) => s.sliceId === 1)?.status).toBe("blocked");
		expect(result.slices.find((s) => s.sliceId === 2)).toEqual({
			sliceId: 2,
			status: "blocked-upstream",
			blockedBy: [1],
			changedFiles: [],
			deferrals: [],
			unverifiedStages: [],
			notes: { durable: [], scratch: [] },
			summary: "blocked upstream by slice 1",
		});
		expect(wave.labels.filter((label) => sliceOf(label) === "2")).toEqual([]);
	});

	test("lets a dependent run after needs-attention without a CRITICAL deferral", async () => {
		const wave = gateWave(chain, {
			script: (key, id) =>
				key === "js" && id === "1"
					? { findings: [{ severity: "MEDIUM", file: "a.ts", issue: "x", owner: "engineering" }] }
					: undefined,
			extra: { maxCorrectionRounds: 0 },
		});
		expect((await wave.byId(1))?.status).toBe("needs-attention");
		expect((await wave.byId(2))?.status).toBe("clean");
		expect(wave.labels).toContain("red:2");
	});

	test("blocks a dependent after needs-attention with a live CRITICAL deferral", async () => {
		const wave = gateWave(chain, {
			script: (key, id) =>
				key === "js" && id === "1"
					? { findings: [{ severity: "CRITICAL", file: "a.ts", issue: "x", owner: "engineering" }] }
					: undefined,
			extra: { maxCorrectionRounds: 0 },
		});
		const first = await wave.byId(1);
		expect(first?.status).toBe("needs-attention");
		expect(first?.deferrals).toContainEqual({ type: "CRITICAL", text: "a.ts: x" });
		const second = await wave.byId(2);
		expect(second?.status).toBe("blocked-upstream");
		expect(second?.blockedBy).toEqual([1]);
		expect(wave.labels).not.toContain("red:2");
	});

	test("blocks a dependent when its dependency is unverified", async () => {
		const wave = gateWave(chain, {
			script: (key, id) => (key === "yellow" && id === "1" ? null : undefined),
		});
		expect((await wave.byId(1))?.status).toBe("unverified");
		expect((await wave.byId(2))?.status).toBe("blocked-upstream");
	});

	test("gates string ids and treats numeric 1 and string \"1\" as the same slice", async () => {
		const letters = gateWave([{ id: "A" }, { id: "A2", dependsOn: ["A"] }], { hold: "A" });
		await heldAt(letters, "red:A");
		expect(letters.labels).not.toContain("red:A2");
		letters.release();
		await letters.done;
		expect(letters.labels.indexOf("red:A2")).toBeGreaterThan(lastIndexFor(letters.labels, "A"));

		const mixed = gateWave([{ id: 1 }, { id: 2, dependsOn: ["1"] }], { hold: "1" });
		await heldAt(mixed, "red:1");
		expect(mixed.labels).not.toContain("red:2");
		mixed.release();
		await mixed.done;
		expect(mixed.labels).toContain("red:2");

		const reverse = gateWave([{ id: "1" }, { id: 2, dependsOn: [1] }], { hold: "1" });
		await heldAt(reverse, "red:1");
		expect(reverse.labels).not.toContain("red:2");
		reverse.release();
		await reverse.done;
		expect(reverse.labels).toContain("red:2");
	});

	test("treats a dependency outside the run as already done", async () => {
		const wave = gateWave([{ id: 2, dependsOn: [99] }]);
		expect((await wave.byId(2))?.status).toBe("clean");
		expect(wave.labels).toContain("red:2");
	});

	test("makes dependents blocked-upstream when the dependency's pipeline threw", async () => {
		const wave = gateWave(chain, { throwFor: "red:1" });
		const result = await wave.done;
		expect(result.droppedSlices).toEqual([1]);
		const second = result.slices.find((slice) => slice.sliceId === 2);
		expect(second?.status).toBe("blocked-upstream");
		expect(second?.blockedBy).toEqual([1]);
		expect(wave.labels).not.toContain("red:2");
	});

	test("returns blocked-upstream for slices in a dependency cycle or self-dependency", async () => {
		const wave = gateWave([
			{ id: 1, dependsOn: [2] },
			{ id: 2, dependsOn: [1] },
			{ id: 3, dependsOn: [3] },
			{ id: 4, dependsOn: [1] },
		]);
		const result = await wave.done;
		expect(result.slices.map((slice) => slice.status)).toEqual(Array(4).fill("blocked-upstream"));
		expect(wave.labels).toEqual([]);
	});

	test("blocks every slice that shares an id and runs no stage for them", async () => {
		const wave = gateWave([{ id: 1 }, { id: 1 }, { id: 2, dependsOn: [1] }]);
		const result = await wave.done;
		expect(result.slices.map((slice) => [slice.sliceId, slice.status])).toEqual([
			[1, "blocked"],
			[1, "blocked"],
			[2, "blocked-upstream"],
		]);
		expect(result.slices[0]?.summary).toBe("duplicate slice id 1");
		expect(result.slices[2]?.blockedBy).toEqual([1]);
		expect(wave.labels).toEqual([]);
	});

	test("returns blocked-upstream for each slice of a two-slice cycle", async () => {
		const wave = gateWave([
			{ id: 1, dependsOn: [2] },
			{ id: 2, dependsOn: [1] },
		]);
		const result = await wave.done;
		expect(result.slices.map((slice) => slice.status)).toEqual(["blocked-upstream", "blocked-upstream"]);
		expect(wave.labels).toEqual([]);
	});

	const blockRed1 = (key: string, id: string) =>
		key === "red" && id === "1" ? { testFiles: [], deferrals: [{ type: "SPEC", text: "q" }] } : undefined;

	test("blocks a dependent of a blocked-upstream slice transitively", async () => {
		const wave = gateWave([{ id: 1 }, { id: 2, dependsOn: [1] }, { id: 3, dependsOn: [2] }], {
			script: blockRed1,
		});
		const third = await wave.byId(3);
		expect(third?.status).toBe("blocked-upstream");
		expect(third?.blockedBy).toEqual([2]);
		expect(wave.labels.some((label) => /:3$/.test(label))).toBe(false);
	});

	test("lists each failed dependency once in blockedBy", async () => {
		const wave = gateWave(
			[{ id: 1 }, { id: 2 }, { id: 3, dependsOn: [1, 1, 2] }],
			{ script: (key) => (key === "red" ? { testFiles: [], deferrals: [{ type: "SPEC", text: "q" }] } : undefined) },
		);
		expect((await wave.byId(3))?.blockedBy).toEqual([1, 2]);
	});

	test.each(["yellow:1", "green:1", "js:1#0"])(
		"makes dependents blocked-upstream when %s throws",
		async (label) => {
			const wave = gateWave(chain, { throwFor: label });
			const result = await wave.done;
			expect(result.droppedSlices).toEqual([1]);
			expect(result.slices.find((slice) => slice.sliceId === 2)?.status).toBe("blocked-upstream");
			expect(wave.labels).not.toContain("red:2");
		},
	);

	test("blocks a dependent when the dependency blocked on a correction deferral", async () => {
		const wave = gateWave(chain, {
			script: (key, id) => {
				if (key === "js" && id === "1")
					return { findings: [{ severity: "MEDIUM", file: "a.ts", issue: "x", owner: "engineering" }] };
				if (key === "fix" && id === "1")
					return { changedFiles: [], testsPass: true, deferrals: [{ type: "SPEC", text: "shape?" }] };
				return undefined;
			},
		});
		expect((await wave.byId(1))?.status).toBe("blocked");
		expect((await wave.byId(2))?.status).toBe("blocked-upstream");
		expect(wave.labels).not.toContain("red:2");
	});

	test("logs the profile line once with the baked profile and correction rounds", async () => {
		const wave = gateWave(chain, { extra: { profile: "cheap", maxCorrectionRounds: 1 } });
		await wave.done;
		const lines = wave.logs.filter((line) => line.startsWith("profile "));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe("profile cheap \u00b7 correction rounds 1 \u00b7 slices 1, 2");
	});

	test("logs profile balance and 2 correction rounds when args carry neither", async () => {
		const wave = gateWave(chain);
		await wave.done;
		expect(wave.logs.filter((line) => line.startsWith("profile "))).toEqual([
			"profile balance \u00b7 correction rounds 2 \u00b7 slices 1, 2",
		]);
	});

	test("runs at most one fix round with maxCorrectionRounds 1", async () => {
		const wave = gateWave([{ id: 1 }], {
			script: (key) =>
				key === "js"
					? { findings: [{ severity: "MEDIUM", file: "a.ts", issue: "x", owner: "engineering" }] }
					: undefined,
			extra: { maxCorrectionRounds: 1 },
		});
		await wave.done;
		expect(wave.labels.filter((label) => label.startsWith("fix:"))).toEqual([
			"fix:engineering:1#1",
		]);
	});
});

describe("slice-wave runner docs", () => {
	const read = (path: string) => readFileSync(join(SKILLS, path), "utf8");

	test("finish.md step 5 names execution.profile, a cheap cap of 1 and the four cheap efforts", () => {
		const text = read("sdlc/references/finish.md");
		expect(text).toContain("execution.profile");
		expect(text).toContain("max rounds per profile: 2, cheap 1");
		expect(text).toContain("After the last round");
		expect(text).toContain(
			"dg:reviewer, dg:qa-perf and dg:qa-devops run at `low` and dg:security at `medium`",
		);
		expect(text).toContain("Under cheap, the correction cap is 1 round");
	});

	test("sdlc/SKILL.md stays within the line budget", () => {
		const lines = read("sdlc/SKILL.md").trimEnd().split("\n").length;
		expect(lines).toBeLessThanOrEqual(74);
	});

	describe("engineering.md", () => {
		const text = read("sdlc/references/engineering.md");
		const section = (n: string) => {
			const start = text.indexOf(`## ${n}`);
			expect(start).toBeGreaterThanOrEqual(0);
			const next = text.indexOf("\n## ", start + 1);
			return text.slice(start, next === -1 ? undefined : next);
		};

		test("keeps headings 4.1, 4.2 and 4.3 and passes no --layer to resolve", () => {
			for (const n of ["4.1", "4.2", "4.3"]) expect(text).toContain(`## ${n}`);
			expect(section("4.2")).toContain("dg-skills assign resolve");
			expect(section("4.2")).not.toContain("--layer");
		});

		test("4.3 names the slice commit subject, re-run selection and shared-file rule", () => {
			const body = section("4.3");
			expect(body).toContain("slice-<N>:");
			expect(body).toContain("default selection");
			expect(body).toContain("--slices");
			expect(body).toMatch(/later slice/);
		});

		test("4.3 re-runs dropped slices and walks results in lint-waves layer order", () => {
			const body = section("4.3");
			expect(body).toContain("droppedSlices");
			expect(body).toContain("`layer N:`");
			expect(body).toContain("dg-skills spec lint-waves");
		});

		test("4.2 returns droppedSlices and describes the no-pending and cycle behavior", () => {
			const body = section("4.2");
			expect(body).toContain("droppedSlices");
			expect(body).toContain("`no pending slices`");
			expect(body).toContain("exits 0");
			expect(body).not.toMatch(/hangs/);
			expect(body).toMatch(/cycle[^.]*`blocked-upstream`/);
		});
	});
});

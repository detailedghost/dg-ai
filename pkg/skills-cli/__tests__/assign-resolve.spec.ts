import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/assign";
import { parseYaml, frontmatterOf } from "../src/spec/frontmatter";
import { lintFile } from "../src/spec/lint-waves";

const FIXTURES = join(import.meta.dir, "fixtures", "assign");
const RUNNER = join(
	import.meta.dir,
	"../../../plugins/dg/skills/sdlc/references/templates/slice-wave.workflow.js",
);
const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");
const plan = (name: string) => join(FIXTURES, name);

interface Run {
	status: number;
	out: string;
	err: string;
}

async function run(argv: string[]): Promise<Run> {
	let out = "";
	let err = "";
	const stdout = process.stdout.write.bind(process.stdout);
	const stderr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		const status = await main(argv);
		return { status, out, err };
	} finally {
		process.stdout.write = stdout;
		process.stderr.write = stderr;
	}
}

interface Stage {
	agentType: string;
	model: string | null;
	effort: string;
}

interface Args {
	slices: {
		id: number;
		name: string;
		primary: Stage;
		qa: Stage[];
		proxyBackend?: string;
		proxySkills?: string[];
		proxyFlags?: string;
		testingCriteria: string;
		brief: string;
	}[];
	roles: Record<string, Stage>;
	templates: Record<string, string>;
	specPath: string;
}

async function resolved(argv: string[]): Promise<Args> {
	const result = await run(["resolve", ...argv]);
	expect(result.err).toBe("");
	expect(result.status).toBe(0);
	return JSON.parse(result.out) as Args;
}

const priorSkillsDir = process.env.DG_SKILLS_DIR;
beforeAll(() => {
	process.env.DG_SKILLS_DIR = SKILLS;
});
afterAll(() => {
	if (priorSkillsDir === undefined) delete process.env.DG_SKILLS_DIR;
	else process.env.DG_SKILLS_DIR = priorSkillsDir;
});

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "assign-resolve-"));
	temps.push(dir);
	return dir;
};

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
});

describe("slice-wave runner correction deferrals", () => {
	const stage = { agentType: "dg:js", model: "sonnet", effort: "medium" };
	const body = readFileSync(RUNNER, "utf8").replace(/^export /m, "");

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
		const pipeline = async (
			items: unknown[],
			...stages: ((value: unknown) => unknown)[]
		) =>
			Promise.all(
				items.map(async (item) => {
					let value = item;
					for (const run of stages) value = await run(value);
					return value;
				}),
			);
		const parallel = (jobs: (() => unknown)[]) => Promise.all(jobs.map((job) => job()));
		const args = {
			slices: [{ id: 1, name: "n", primary: stage, qa: [], brief: "", testingCriteria: "", ...extra }],
			roles: { "qa-writer": stage, wave: stage, security: stage },
			templates: { proxy: "go {PROXY_FLAGS} end", correction: "fix" },
		};
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
		const result = await new AsyncFunction(
			"args",
			"pipeline",
			"parallel",
			"agent",
			"log",
			body,
		)(args, pipeline, parallel, agent, () => {});
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

describe("dg-skills assign resolve", () => {
	test.each(["claude", "codex", "grok"])(
		"matches the golden for layer 0 on %s",
		async (runtime) => {
			const { templates, specPath, ...rest } = await resolved([
				plan("plan-high.md"),
				"--layer",
				"0",
				"--runtime",
				runtime,
			]);
			const golden = JSON.parse(
				readFileSync(join(FIXTURES, `layer0.${runtime}.golden.json`), "utf8"),
			);
			expect(specPath).toBe(plan("plan-high.md"));
			expect({
				...rest,
				templateKeys: Object.keys(templates),
			}).toEqual(golden);
		},
	);

	test("prints identical JSON on repeated runs", async () => {
		const argv = ["resolve", plan("plan-high.md"), "--layer", "1"];
		expect((await run(argv)).out).toBe((await run(argv)).out);
	});

	test.each([0, 1])("layer %i holds the slices lint-waves puts there", async (layer) => {
		const report = await lintFile(plan("plan-high.md"));
		const line = report.text
			.split("\n")
			.find((row) => row.startsWith(`layer ${layer}:`));
		const expected = (line ?? "").replace(/^layer \d+:/, "").trim().split(" ");
		const { slices } = await resolved([plan("plan-high.md"), "--layer", String(layer)]);
		expect(slices.map((slice) => String(slice.id))).toEqual(expected);
	});

	test("exits 1 when the layer holds no slices", async () => {
		const result = await run(["resolve", plan("plan-high.md"), "--layer", "9"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain("layer 9");
	});

	test("exits 2 when --layer is missing", async () => {
		expect((await run(["resolve", plan("plan-high.md")])).status).toBe(2);
	});

	test("exits 1 and names /dg:assign when a slice has no primary", async () => {
		const result = await run(["resolve", plan("plan-unassigned.md"), "--layer", "0"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain("run /dg:assign");
	});

	test("resolves tiers, qualified agent types and the slice effort override", async () => {
		const { slices, roles } = await resolved([plan("plan-high.md"), "--layer", "0"]);
		expect(slices[0]?.primary).toEqual({
			agentType: "dg:js",
			model: "sonnet",
			effort: "medium",
		});
		expect(slices[0]?.qa.map((stage) => stage.agentType)).toEqual(["dg:qa-code"]);
		expect(slices[1]?.primary.effort).toBe("xhigh");
		expect(roles.wave?.model).toBe("haiku");
		expect(roles.security?.model).toBe("opus");
		expect(roles["qa-writer"]?.agentType).toBe("dg:qa-writer");
	});

	test("lets an arch slice pin fable", async () => {
		const { slices } = await resolved([plan("plan-fable.md"), "--layer", "0"]);
		expect(slices[0]?.primary).toEqual({
			agentType: "dg:arch",
			model: "fable",
			effort: "xhigh",
		});
	});

	test("exits 1 when ## Execution pins fable on a slice whose primary is not a fable agent", async () => {
		const result = await run([
			"resolve",
			plan("plan-fable-pinned-js.md"),
			"--layer",
			"0",
		]);
		expect(result.status).toBe(1);
		expect(result.err).toContain("fable");
	});

	test("applies the ## Execution pin to the build stages and leaves the wave audit alone", async () => {
		const { slices, roles } = await resolved([plan("plan-pin-opus-js.md"), "--layer", "0"]);
		expect(slices[0]?.primary).toMatchObject({ model: "opus", effort: "xhigh" });
		expect(roles["qa-writer"]).toMatchObject({ model: "opus", effort: "xhigh" });
		expect(roles.wave).toMatchObject({ model: "haiku", effort: "low" });
	});

	test("inlines the five templates with the return-contract reminder", async () => {
		const { templates } = await resolved([plan("plan-high.md"), "--layer", "0"]);
		expect(Object.keys(templates).sort()).toEqual([
			"correction",
			"green",
			"red",
			"wave",
			"yellow",
		]);
		for (const body of Object.values(templates))
			expect(body.startsWith("Workflow return contract:")).toBe(true);
	});

	test("gives every stage the slice context through runner tokens", async () => {
		const { templates } = await resolved([plan("plan-high.md"), "--layer", "1"]);
		for (const key of ["red", "yellow", "green", "wave", "correction"])
			for (const token of ["{SLICE_ID}", "{SLICE_BRIEF}", "{TESTING_CRITERIA}", "{SPEC_PATH}"])
				expect(templates[key], `${key} ${token}`).toContain(token);
		for (const key of ["yellow", "green", "wave", "correction"])
			expect(templates[key], key).toContain("{CHANGED_FILES}");
		for (const key of ["correction", "proxy"])
			expect(templates[key], key).toContain("{FINDINGS}");
	});

	test("makes the reminder override every template and routes questions to deferrals", async () => {
		const { templates } = await resolved([plan("plan-high.md"), "--layer", "1"]);
		for (const body of Object.values(templates)) {
			expect(body).not.toContain("unless this template says so");
			expect(body).toContain("deferrals[]");
		}
		expect(templates.proxy).not.toMatch(/ask the user via `AskUserQuestion`/);
	});

	test("names the --cwd working directory in every stage prompt, proxy included", async () => {
		const { templates } = await resolved([
			plan("plan-high.md"),
			"--layer",
			"1",
			"--cwd",
			"/work/tree",
		]);
		for (const [key, body] of Object.entries(templates))
			expect(body, key).toContain("Working directory: /work/tree");
		expect(templates.proxy).toContain("--cwd '/work/tree'");
		expect(templates.proxy).not.toContain("<repo working directory>");
	});

	test("defaults the working directory to the git top level", async () => {
		const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"])
			.stdout.toString()
			.trim();
		const { templates } = await resolved([plan("plan-high.md"), "--layer", "0"]);
		expect(templates.red).toContain(`Working directory: ${top}`);
	});

	test("briefs slices whose id is a string, without bleeding into a longer id", async () => {
		const { slices } = await resolved([plan("plan-string-ids.md"), "--layer", "0"]);
		const [alpha, alphaTwo] = slices;
		expect(alpha?.brief).toContain("Build alpha");
		expect(alpha?.brief).not.toContain("Build alpha two");
		expect(alpha?.testingCriteria).toContain("Test alpha");
		expect(alphaTwo?.brief).toContain("Build alpha two");
	});

	test("does not fold a hyphenated sibling id into a shorter id", async () => {
		const dir = scratch();
		const file = join(dir, "plan.md");
		const text = readFileSync(plan("plan-string-ids.md"), "utf8")
			.replaceAll("A2", "api-tests")
			.replaceAll("id: A\n", "id: api\n")
			.replaceAll("Slice A ", "Slice api ");
		writeFileSync(file, text);
		const { slices } = await resolved([file, "--layer", "0"]);
		expect(slices[0]?.brief).toContain("Build alpha");
		expect(slices[0]?.brief).not.toContain("Build alpha two");
	});

	test("lets stage prompts read the spec, scratchpad and referenced assets from outside the working directory", async () => {
		const { templates } = await resolved([plan("plan-high.md"), "--layer", "0"]);
		for (const [key, body] of Object.entries(templates)) {
			expect(body, key).toContain("You may read the spec, the scratchpad and referenced assets");
			expect(body, key).not.toContain("read and edit files only under it");
		}
	});

	test("exits 1 when a slice effort override is empty", async () => {
		const dir = scratch();
		const file = join(dir, "plan.md");
		writeFileSync(
			file,
			readFileSync(plan("plan-high.md"), "utf8").replace("effort: xhigh", 'effort: ""'),
		);
		const result = await run(["resolve", file, "--layer", "0"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain("Effort");
	});

	test("shell-quotes a working directory with spaces, an apostrophe and a dollar sign in the proxy command", async () => {
		const cwd = "/work/it's $HOME tree";
		const { templates } = await resolved([
			plan("plan-high.md"),
			"--layer",
			"1",
			"--cwd",
			cwd,
		]);
		expect(templates.proxy).toContain(`--cwd '/work/it'\\''s $HOME tree'`);
	});

	test("hands a proxied slice its effort override and tier pin as proxy flags", async () => {
		const { slices, templates } = await resolved([plan("plan-proxy-pin.md"), "--layer", "0"]);
		expect(slices[0]?.proxyFlags).toBe("--effort xhigh");
		expect(slices[1]?.proxyFlags).toBeUndefined();
		expect(templates.proxy).toContain("{PROXY_FLAGS}");
	});

	test("adds the ## Execution tier pin to the proxy flags", async () => {
		const dir = scratch();
		const file = join(dir, "plan.md");
		writeFileSync(
			file,
			`${readFileSync(plan("plan-proxy-pin.md"), "utf8")}\n## Execution\nmodel: opus\n`,
		);
		const { slices } = await resolved([file, "--layer", "0"]);
		expect(slices[0]?.proxyFlags).toBe("--effort xhigh --tier opus");
		expect(slices[1]?.proxyFlags).toBe("--tier opus");
	});

	test.each([
		"model: opus-4.5",
		"effort: xhigh2",
		"- Model: opus",
		"- **model:** opus",
		"- model : opus",
		"- effort = xhigh",
	])("exits 1 on the malformed ## Execution line %p", async (line) => {
		const dir = scratch();
		const file = join(dir, "plan.md");
		writeFileSync(
			file,
			`${readFileSync(plan("plan-high.md"), "utf8")}\n## Execution\n${line}\n`,
		);
		const result = await run(["resolve", file, "--layer", "0"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain("## Execution");
	});

	test("accepts the strict ## Execution forms", async () => {
		const dir = scratch();
		const file = join(dir, "plan.md");
		writeFileSync(
			file,
			`${readFileSync(plan("plan-high.md"), "utf8")}\n## Execution\n- model: \`opus\`\n* effort: "xhigh"\nprose about the run\n`,
		);
		expect((await run(["resolve", file, "--layer", "0"])).status).toBe(0);
	});

	test("keeps proxy_skills on a proxied slice and inlines each skill into its brief", async () => {
		const { slices } = await resolved([plan("plan-high.md"), "--layer", "1"]);
		expect(slices[0]?.proxySkills).toEqual(["polish"]);
		expect(slices[0]?.brief).toContain("# Skill: polish");
	});

	test("omits proxySkills from slices that carry none", async () => {
		const { slices } = await resolved([plan("plan-high.md"), "--layer", "0"]);
		expect(slices.every((slice) => !("proxySkills" in slice))).toBe(true);
	});

	test("adds the proxy template only when a slice delegates", async () => {
		const plain = await resolved([plan("plan-high.md"), "--layer", "0"]);
		const proxied = await resolved([plan("plan-high.md"), "--layer", "1"]);
		expect(plain.templates.proxy).toBeUndefined();
		expect(proxied.templates.proxy).toContain("{PROXY_BACKEND}");
		expect(proxied.slices[0]?.proxyBackend).toBe("codex");
	});

	test("writes the runner with the meta literal first, then WAVE_ARGS", async () => {
		const dir = scratch();
		const result = await run([
			"resolve",
			plan("plan-high.md"),
			"--layer",
			"1",
			"--wave",
			dir,
		]);
		const file = join(dir, "slice-wave.layer1.workflow.js");
		expect(result.status).toBe(0);
		expect(result.out.trim()).toBe(file);
		const written = readFileSync(file, "utf8");
		expect(written.startsWith("export const meta = {")).toBe(true);
		expect(written).toMatch(/^\};\nconst WAVE_ARGS = \{/m);
		const metaEnd = written.indexOf("\n};\n") + 4;
		expect(written.slice(metaEnd).startsWith("const WAVE_ARGS = ")).toBe(true);
		expect(written.match(/const WAVE_ARGS/g)).toHaveLength(1);
	});

	test("emits a script that still parses", async () => {
		const dir = scratch();
		await run(["resolve", plan("plan-high.md"), "--layer", "0", "--wave", dir]);
		const file = join(dir, "slice-wave.layer0.workflow.js");
		const copy = join(dir, "check.mjs");
		const body = readFileSync(file, "utf8").replace(/^export /, "");
		writeFileSync(copy, `(async () => {\n${body}\n})`);
		const check = Bun.spawnSync(["node", "--check", copy]);
		expect(check.stderr.toString()).toBe("");
		expect(check.exitCode).toBe(0);
	});
});

describe("confidence fixtures", () => {
	const lowSlices = (name: string) => {
		const parsed = parseYaml(frontmatterOf(readFileSync(plan(name), "utf8")));
		if (!parsed.ok) throw new Error(parsed.error);
		const { slices } = parsed.value as {
			slices: { agents: { confidence: string } }[];
		};
		return slices.filter((slice) => slice.agents.confidence === "low").length;
	};

	test("a plan with every slice high has nothing to ask about", () => {
		expect(lowSlices("plan-high.md")).toBe(0);
	});

	test("a plan with one low slice has exactly one question", () => {
		expect(lowSlices("plan-low.md")).toBe(1);
	});
});

describe("assign resolve --help", () => {
	test.each([["--help"], ["-h"]])("%s prints usage and exits 0", async (flag) => {
		const result = await run(["resolve", flag]);
		expect(result.status).toBe(0);
		expect(result.out).toContain("usage: dg-skills assign resolve");
	});
});

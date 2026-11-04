import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/assign";
import { parseYaml, frontmatterOf } from "../src/spec/frontmatter";
import { lintFile } from "../src/spec/lint-waves";
import { writePlan } from "./assign-plan-builder";

const FIXTURES = join(import.meta.dir, "fixtures", "assign");
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
		files?: string[];
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
	cwd: string;
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

describe("slice ownership globs", () => {
	test("include generator outputs triggered by the slice's own files", async () => {
		const { slices } = await resolved([plan("plan-generated.md"), "--layer", "0"]);
		const files = (id: number) => slices.find((slice) => slice.id === id)?.files;
		expect(files(1)).toEqual(["schema/*.json", "gen/out/*.ts"]);
		expect(files(2)).toEqual(["src/two/**"]);
	});
});

describe("slice context isolation", () => {
	const count = (text: string, needle: string) => text.split(needle).length - 1;

	test.each(["plan-nested.md", "plan-high.md"])(
		"cuts slice 1 brief and criteria from %s without other slices or trailing sections",
		async (name) => {
			const { slices } = await resolved([plan(name), "--layer", "0"]);
			const one = slices.find((slice) => slice.id === 1);
			const text = `${one?.brief}\n${one?.testingCriteria}`;
			expect(text).not.toMatch(/-[23] |Slice [23]|SUMMARY-TAIL|NOTES-TAIL/);
			if (name === "plan-nested.md") {
				expect(count(text, "DIRECTIVE-1")).toBe(1);
				expect(count(text, "CRITERIA-1")).toBe(1);
				expect(one?.brief).not.toContain("Testing Criteria");
			}
		},
	);

	test("fills the runner tokens with one copy of the slice context", async () => {
		const { slices, templates } = await resolved([
			plan("plan-nested.md"),
			"--layer",
			"0",
		]);
		const one = slices[0] as Args["slices"][number];
		const filled = (templates.yellow as string)
			.replaceAll("{SLICE_BRIEF}", one.brief)
			.replaceAll("{TESTING_CRITERIA}", one.testingCriteria);
		expect(count(filled, "CRITERIA-1")).toBe(1);
		expect(count(filled, "DIRECTIVE-1")).toBe(1);
	});
});

describe("slice-wave templates", () => {
	const dir = join(SKILLS, "sdlc/references/templates");
	test.each([
		"qa-writer-red.md",
		"slice-engineering.md",
		"qa-writer-green.md",
		"correction.md",
	])("%s tells agents not to edit the spec or tick checkboxes", (name) => {
		const text = readFileSync(join(dir, name), "utf8");
		expect(text).not.toMatch(/Update (remaining unchecked|checkboxes)/i);
		expect(text).toContain(
			"Do not edit the spec or report unticked checkboxes; the orchestrator ticks them.",
		);
	});
});

describe("dg-skills assign resolve", () => {
	test.each(["claude", "codex", "grok"])(
		"matches the golden for layer 0 on %s",
		async (runtime) => {
			const { templates, specPath, cwd, ...rest } = await resolved([
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

	test("bakes each slice's file globs into the args", async () => {
		const { slices } = await resolved([plan("plan-high.md"), "--layer", "0"]);
		expect(slices.map((slice) => (slice as { files?: string[] }).files)).toEqual([
			["src/parser/**"],
			["src/db/**"],
		]);
	});

	test("bakes the worktree cwd into the args", async () => {
		const { cwd } = await resolved([
			plan("plan-high.md"),
			"--layer",
			"0",
			"--cwd",
			"/work/tree",
		]);
		expect(cwd).toBe("/work/tree");
	});

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

	test("exits 2 when the plan argument is missing", async () => {
		expect((await run(["resolve", "--layer", "0"])).status).toBe(2);
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

	test("exits 1 with the fable message when agents.model is fable on a dg:js primary", async () => {
		const file = writePlan(scratch(), {
			slices: [{ id: 1, primary: "dg:js", model: "fable" }],
		});
		const result = await run(["resolve", file, "--layer", "0"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain("cannot use the fable tier");
	});

	test("agents.model opus on a sonnet primary resolves to opus at its default effort", async () => {
		const file = writePlan(scratch(), {
			slices: [{ id: 1, primary: "dg:js", model: "opus" }],
		});
		const { slices, roles } = await resolved([file, "--layer", "0"]);
		expect(slices[0]?.primary).toMatchObject({ model: "opus", effort: "xhigh" });
		expect(roles.wave).toMatchObject({ model: "haiku", effort: "low" });
	});

	test("agents.effort low on the same slice keeps opus and lowers the effort", async () => {
		const file = writePlan(scratch(), {
			slices: [{ id: 1, primary: "dg:js", model: "opus", effort: "low" }],
		});
		const { slices } = await resolved([file, "--layer", "0"]);
		expect(slices[0]?.primary).toMatchObject({ model: "opus", effort: "low" });
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

	test("adds the agents.model tier to the proxy flags and omits an effort equal to the tier default", async () => {
		const dir = scratch();
		const file = join(dir, "plan.md");
		writeFileSync(
			file,
			readFileSync(plan("plan-proxy-pin.md"), "utf8").replaceAll(
				"      proxy: codex\n",
				"      proxy: codex\n      model: opus\n",
			),
		);
		const { slices } = await resolved([file, "--layer", "0"]);
		expect(slices[0]?.proxyFlags).toBe("--tier opus");
		expect(slices[1]?.proxyFlags).toBe("--tier opus");
	});

	test("ignores ## Execution text in the plan body", async () => {
		const dir = scratch();
		const file = join(dir, "plan.md");
		const base = readFileSync(plan("plan-high.md"), "utf8");
		writeFileSync(file, `${base}\n## Execution\nmodel: opus\neffort: low\n`);
		const withSection = await run(["resolve", file, "--layer", "0"]);
		const without = await run(["resolve", plan("plan-high.md"), "--layer", "0"]);
		expect(withSection.status).toBe(0);
		const strip = (text: string) => {
			const { specPath, ...rest } = JSON.parse(text) as Record<string, unknown>;
			return rest;
		};
		expect(strip(withSection.out)).toEqual(strip(without.out));
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
	}, 30000);
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


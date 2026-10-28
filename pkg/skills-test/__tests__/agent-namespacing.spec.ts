import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { bareAgent } from "@dg/common";
import { qualifiedAgent } from "../../skills-cli/src/proxy/packaged-personas";
import { loadTiers, resolveAgent, type Tier } from "../../skills-cli/src/tiers";
import { REPO_ROOT } from "./test-support";

const PLUGIN_DIR = join(REPO_ROOT, "plugins", "dg");
const SKILLS_DIR = join(PLUGIN_DIR, "skills");
const SLICE_WAVE = join(
	SKILLS_DIR,
	"sdlc",
	"references",
	"templates",
	"slice-wave.workflow.js",
);

const AGENTS = readdirSync(join(PLUGIN_DIR, "agents"))
	.filter((file) => file.endsWith(".md"))
	.map((file) => file.slice(0, -3))
	.sort();

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		if (entry === "node_modules" || entry === "astro-viewer") return [];
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return files(path);
		return /\.(md|js|mjs)$/.test(entry) ? [path] : [];
	});
}

const LAUNCH_FILES = files(SKILLS_DIR).map((path) => ({
	name: relative(SKILLS_DIR, path).split(sep).join("/"),
	text: readFileSync(path, "utf8"),
}));

const NAMES = AGENTS.join("|");
const AGENTS_SHARING_A_SKILL_NAME = ["thrash"];
const BACKTICK_NAMES = AGENTS.filter(
	(name) => !AGENTS_SHARING_A_SKILL_NAME.includes(name),
).join("|");
const BARE_AGENT = new RegExp(
	[
		`(?<![\\w:/.-])\`(${BACKTICK_NAMES})\`(?![\\w:/-])`,
		`\\*\\*(${NAMES})\\*\\*`,
		`(?:agentType|subagent_type)\\s*[:=]\\s*["'](${NAMES})["']`,
	].join("|"),
);

const NOT_AN_AGENT = new Set([
	"channel-review/references/setup.md",
	"deps-upgrade/references/ecosystems.md",
]);

describe("packaged skills name plugin agents as dg:<agent>", () => {
	test("no skill document launches a shipped agent by its bare name", () => {
		const offenders = LAUNCH_FILES.filter(({ name }) => !NOT_AN_AGENT.has(name))
			.flatMap(({ name, text }) =>
				text
					.split("\n")
					.filter((line) => BARE_AGENT.test(line))
					.map((line) => `${name}: ${line.trim().slice(0, 90)}`),
			);
		expect(offenders).toEqual([]);
	});

	test("the slice-wave workflow names no agent and reads every agentType from a resolved stage", () => {
		const source = readFileSync(SLICE_WAVE, "utf8");
		const calls = source.match(/agentType:.*/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.filter((call) => !call.includes("stage.agentType"))).toEqual([]);
		expect(AGENTS.filter((name) => source.includes(`"${name}"`))).toEqual([
			"qa-writer",
		]);
	});

	test("the helper namespaces shipped agents, accepts either spelling and leaves others bare", () => {
		for (const name of AGENTS) {
			expect(qualifiedAgent(name)).toBe(`dg:${name}`);
			expect(qualifiedAgent(`dg:${name}`)).toBe(`dg:${name}`);
		}
		expect(qualifiedAgent("general-purpose")).toBe("general-purpose");
		expect(qualifiedAgent("Explore")).toBe("Explore");
	});

	test("every shipped agent resolves to its table tier by bare and namespaced name", () => {
		const table = loadTiers();
		expect(Object.keys(table.agents).sort()).toEqual(AGENTS);
		for (const name of AGENTS) {
			const row = table.tiers[table.agents[name] as Tier].claude;
			expect(resolveAgent(bareAgent(name), { runtime: "claude" }).model).toBe(
				row.model,
			);
			expect(resolveAgent(bareAgent(`dg:${name}`), { runtime: "claude" }).model).toBe(
				row.model,
			);
		}
	});
});

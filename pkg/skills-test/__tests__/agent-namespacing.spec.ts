import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

function loadTierMap(): {
	typeFor: (name: string) => string;
	modelFor: (name: string) => string;
	plugin: Set<string>;
} {
	const source = readFileSync(SLICE_WAVE, "utf8");
	const startMarker = "const PLUGIN_AGENTS";
	const endMarker = "// Delegation-table effort default";
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start < 0) throw new Error(`marker not found in slice-wave: ${startMarker}`);
	if (end <= start)
		throw new Error(`marker not found after ${startMarker}: ${endMarker}`);
	const block = source.slice(start, end);
	return new Function(
		"modelOverride",
		`${block}\nreturn { typeFor, modelFor, plugin: PLUGIN_AGENTS };`,
	)(undefined);
}

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

	test("the slice-wave workflow knows exactly the agents that ship", () => {
		expect([...loadTierMap().plugin].sort()).toEqual(AGENTS);
	});

	test("the slice-wave workflow namespaces shipped agents and leaves others bare", () => {
		const { typeFor } = loadTierMap();
		expect(typeFor("qa-writer")).toBe("dg:qa-writer");
		expect(typeFor("dg:js")).toBe("dg:js");
		expect(typeFor("general-purpose")).toBe("general-purpose");
		expect(typeFor("Explore")).toBe("Explore");
	});

	test("the slice-wave model tiers match the bare and the namespaced name", () => {
		const { modelFor } = loadTierMap();
		for (const [agent, model] of [
			["wave", "haiku"],
			["foreman", "fable"],
			["arch", "fable"],
			["design", "fable"],
			["security", "opus"],
			["dba", "opus"],
			["qa-writer", "sonnet"],
		] as const) {
			expect(modelFor(agent)).toBe(model);
			expect(modelFor(`dg:${agent}`)).toBe(model);
		}
	});

	test("every agentType in the slice-wave workflow goes through typeFor", () => {
		const source = readFileSync(SLICE_WAVE, "utf8");
		const calls = source.match(/agentType:.*/g) ?? [];
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.filter((call) => !call.includes("typeFor("))).toEqual([]);
	});
});

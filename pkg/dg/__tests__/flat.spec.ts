import { describe, expect, test } from "bun:test";
import agentTree from "../../dg-agent/src/completion-tree.json" with { type: "json" };
import daemonTree from "../../dg-daemon/src/completion-tree.json" with { type: "json" };
import skillsTree from "../../skills-cli/src/completion/tree.json" with { type: "json" };
import { ALIASES, collisions, GROUPED, GROUPS, groupedPaths, OWNERS, resolveRoute, type Trees } from "../src/flat";
import type { MountName } from "../src/main";

const TREES: Trees = { "dg-skills": skillsTree, "dg-agent": agentTree, "dg-daemon": daemonTree };
const GROUP_OF: Record<MountName, string> = { "dg-skills": "skills", "dg-agent": "agent", "dg-daemon": "daemon" };
const topNames = (program: MountName): string[] =>
	(TREES[program].commands ?? []).map((command) => command.name).filter((name) => name !== "completion");

describe("resolveRoute", () => {
	test.each([
		["pw", "dg-skills", ["pw"]],
		["db", "dg-skills", ["db"]],
		["stat", "dg-skills", ["stat"]],
		["spec", "dg-skills", ["spec"]],
		["adr", "dg-skills", ["adr"]],
		["install", "dg-skills", ["install"]],
		["doctor", "dg-skills", ["doctor"]],
		["update", "dg-skills", ["update"]],
		["config", "dg-skills", ["config"]],
		["phone", "dg-agent", ["phone"]],
		["overwatch", "dg-agent", ["overwatch"]],
		["memory", "dg-agent", ["memory"]],
		["mcp", "dg-agent", ["mcp"]],
		["job", "dg-daemon", ["job"]],
		["autostart", "dg-daemon", ["autostart"]],
		["service", "dg-daemon", ["service"]],
		["upgrade", "dg-skills", ["update"]],
		["extension", "dg-skills", ["install"]],
		["skills", "dg-skills", []],
		["agent", "dg-agent", []],
		["daemon", "dg-daemon", []],
	] as const)("dg %s routes to %s %j", (word, program, command) => {
		expect(resolveRoute(word)).toEqual({ program, command: [...command] });
	});

	test.each(["start", "serve", "status", "stop", "restart", "sessions", "origin", "send", "recv", "progress", "spawn", "stage", "close", "manifest"])(
		"grouped verb %s has no flat route",
		(word) => {
			expect(resolveRoute(word)).toBeUndefined();
		},
	);

	test.each(["nope", "toString", "constructor", "__proto__", "completion", "help", "dg-skills", ""])("%p has no route", (word) => {
		expect(resolveRoute(word)).toBeUndefined();
	});

	test("every top-level name of the three trees is reachable flat or under its group", () => {
		for (const program of Object.keys(TREES) as MountName[]) {
			for (const name of topNames(program)) {
				const flat = resolveRoute(name);
				const grouped = GROUPED[program].includes(name);
				if (grouped) {
					expect(resolveRoute(GROUP_OF[program])).toEqual({ program, command: [] });
					expect(groupedPaths(name)).toContain(`dg ${GROUP_OF[program]} ${name}`);
				} else {
					expect(flat).toEqual({ program, command: [name] });
				}
			}
		}
	});

	test("no flat name resolves to two programs and the real trees have no unowned collision", () => {
		expect(collisions()).toEqual([]);
	});

	test("the group, alias and owner tables name real programs and real commands", () => {
		for (const group of Object.values(GROUPS)) expect(Object.keys(TREES)).toContain(group.program);
		for (const alias of Object.values(ALIASES)) expect(topNames(alias.program)).toContain(alias.command[0] as string);
		for (const [name, program] of Object.entries(OWNERS)) expect(topNames(program)).toContain(name);
		for (const [program, names] of Object.entries(GROUPED) as [MountName, readonly string[]][])
			for (const name of names) expect(topNames(program)).toContain(name);
	});
});

describe("collisions", () => {
	const tree = (...names: string[]) => ({ commands: names.map((name) => ({ name, description: name })) });

	test("a name two trees share with no owner names the name and both programs", () => {
		const trees: Trees = { "dg-skills": tree("pw", "frob"), "dg-agent": tree("frob"), "dg-daemon": tree() };
		expect(collisions(trees)).toEqual([{ name: "frob", programs: ["dg-skills", "dg-agent"] }]);
	});

	test("a tree name that shadows a group, an alias or a dg name is a collision", () => {
		const trees: Trees = { "dg-skills": tree("agent", "upgrade", "help"), "dg-agent": tree(), "dg-daemon": tree() };
		expect(collisions(trees).map((entry) => entry.name)).toEqual(["agent", "upgrade", "help"]);
	});

	test("a grouped name that two trees share is not a collision", () => {
		const trees: Trees = { "dg-skills": tree(), "dg-agent": tree("start"), "dg-daemon": tree("start") };
		expect(collisions(trees)).toEqual([]);
	});
});

describe("groupedPaths", () => {
	test("start names both groups", () => {
		expect(groupedPaths("start")).toEqual(["dg agent start", "dg daemon start"]);
	});

	test("serve names the daemon group only", () => {
		expect(groupedPaths("serve")).toEqual(["dg daemon serve"]);
	});

	test("a flat name has no grouped path", () => {
		expect(groupedPaths("pw")).toEqual([]);
	});
});

import { expect, test } from "bun:test";
import { bareAgent, PLUGIN_AGENT_PREFIX } from "../src/agent-name";

test("strips the plugin prefix", () => {
	expect(bareAgent(`${PLUGIN_AGENT_PREFIX}wave`)).toBe("wave");
});

test("leaves an unprefixed name unchanged", () => {
	expect(bareAgent("wave")).toBe("wave");
});

test("strips the prefix only once", () => {
	expect(bareAgent("dg:dg:wave")).toBe("dg:wave");
});

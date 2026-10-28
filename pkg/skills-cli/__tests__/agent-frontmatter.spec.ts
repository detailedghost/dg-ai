import { describe, expect, test } from "bun:test";

import { frontmatterOf, scalarField } from "../src/spec/frontmatter";
import { packagedPersonas } from "../src/proxy/packaged-personas";
import { loadTiers } from "../src/tiers";

const table = loadTiers();

describe("agent frontmatter", () => {
	test.each(Object.entries(packagedPersonas))(
		"%s model matches its table tier",
		(name, text) => {
			const front = frontmatterOf(text);
			expect(scalarField(front, "model")).toBe(
				table.tiers[table.agents[name]].claude.model ?? "",
			);
		},
	);

	test.each(Object.entries(packagedPersonas))(
		"%s effort, when present, matches its table tier",
		(name, text) => {
			const effort = scalarField(frontmatterOf(text), "effort");
			if (effort !== "")
				expect(effort).toBe(table.tiers[table.agents[name]].claude.effort);
		},
	);
});

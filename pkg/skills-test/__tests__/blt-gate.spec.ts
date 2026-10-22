import { describe, expect, test } from "bun:test";
import {
	BLT_CHECKS,
	requiredChecks,
	touches,
	watchedPaths,
} from "../../../scripts/blt-gate";
import { REPO_ROOT, readRepoFile } from "./test-support";

describe("blt-gate waits for exactly the BLT checks a PR starts", () => {
	test.each([...BLT_CHECKS])(
		"reads a non-empty paths list from %s.yml",
		(name) => {
			const paths = watchedPaths(
				readRepoFile(".github", "workflows", `${name}.yml`),
			);
			expect(paths.length).toBeGreaterThan(0);
			expect(paths).toContain(`.github/workflows/${name}.yml`);
		},
	);

	test("a docs-only PR needs no BLT check", () => {
		expect(
			requiredChecks(REPO_ROOT, ["CONTRIBUTING.md", "docs/adr/toc.md"]),
		).toEqual([]);
	});

	test("a change in pkg/common needs every BLT check", () => {
		expect(
			requiredChecks(REPO_ROOT, ["pkg/common/src/index.ts"]).sort(),
		).toEqual([...BLT_CHECKS].sort());
	});

	test("a dg-daemon change needs the daemon, agent, and skills checks but not the extension", () => {
		expect(
			requiredChecks(REPO_ROOT, ["pkg/dg-daemon/src/index.ts"]).sort(),
		).toEqual(["dg-agent-blt", "dg-daemon-blt", "skills-blt"]);
	});

	test("a directory glob matches only files inside that directory", () => {
		expect(touches(["pkg/common/**"], ["pkg/common-extra/x.ts"])).toBe(false);
		expect(touches(["bun.lock"], ["bun.lock"])).toBe(true);
	});
});

import { describe, expect, test } from "bun:test";
import {
	BLT_CHECKS,
	gate,
	requiredChecks,
	touches,
	watchedPaths,
	type GateDeps,
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

	test.each([...BLT_CHECKS])(
		"%s.yml paths use only exact-path or dir/** forms",
		(name) => {
			const paths = watchedPaths(
				readRepoFile(".github", "workflows", `${name}.yml`),
			);
			for (const pattern of paths) {
				const isDirGlob =
					pattern.endsWith("/**") && !pattern.slice(0, -3).includes("*");
				const isExact = !pattern.includes("*");
				expect(isDirGlob || isExact).toBe(true);
			}
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

function spawnResult(success: boolean, stdout: string, stderr: string) {
	return {
		success,
		stdout: { toString: () => stdout },
		stderr: { toString: () => stderr },
	};
}

function checkRunResponse(status: string, conclusion: string | null): Response {
	return new Response(
		JSON.stringify({ check_runs: [{ id: 1, status, conclusion }] }),
		{ status: 200 },
	);
}

const options = {
	root: REPO_ROOT,
	baseSha: "base",
	headSha: "head",
	repo: "detailedghost/dg-ai",
	token: "test-token",
};

describe("gate polls the required BLT checks to a pass/fail decision", () => {
	test("throws when git diff fails instead of treating it as no changes", async () => {
		const deps: Partial<GateDeps> = {
			spawnSync: () => spawnResult(false, "", "fatal: bad revision"),
		};
		await expect(gate(options, deps)).rejects.toThrow("fatal: bad revision");
	});

	test("resolves without polling when no BLT check applies", async () => {
		let fetchCalls = 0;
		const deps: Partial<GateDeps> = {
			spawnSync: () => spawnResult(true, "docs/contributing.md\n", ""),
			fetch: async () => {
				fetchCalls += 1;
				throw new Error("should not poll when nothing is required");
			},
		};
		await gate(options, deps);
		expect(fetchCalls).toBe(0);
	});

	test("resolves once the required check completes with success", async () => {
		const deps: Partial<GateDeps> = {
			spawnSync: () => spawnResult(true, ".github/workflows/ext-blt.yml\n", ""),
			fetch: async () => checkRunResponse("completed", "success"),
			sleep: async () => {},
		};
		await expect(gate(options, deps)).resolves.toBeUndefined();
	});

	test("throws when the required check completes with failure", async () => {
		const deps: Partial<GateDeps> = {
			spawnSync: () => spawnResult(true, ".github/workflows/ext-blt.yml\n", ""),
			fetch: async () => checkRunResponse("completed", "failure"),
			sleep: async () => {},
		};
		await expect(gate(options, deps)).rejects.toThrow(
			"ext-blt finished with failure",
		);
	});

	test("retries a network-level fetch error on the next poll tick", async () => {
		let calls = 0;
		const deps: Partial<GateDeps> = {
			spawnSync: () => spawnResult(true, ".github/workflows/ext-blt.yml\n", ""),
			fetch: async () => {
				calls += 1;
				if (calls === 1) throw new TypeError("network down");
				return checkRunResponse("completed", "success");
			},
			sleep: async () => {},
		};
		await gate(options, deps);
		expect(calls).toBe(2);
	});

	test("still throws on an HTTP error response instead of retrying", async () => {
		let calls = 0;
		const deps: Partial<GateDeps> = {
			spawnSync: () => spawnResult(true, ".github/workflows/ext-blt.yml\n", ""),
			fetch: async () => {
				calls += 1;
				return new Response("", { status: 500 });
			},
			sleep: async () => {},
		};
		await expect(gate(options, deps)).rejects.toThrow("HTTP 500");
		expect(calls).toBe(1);
	});

	test("times out waiting for a check that never completes", async () => {
		let clock = 0;
		const deps: Partial<GateDeps> = {
			spawnSync: () => spawnResult(true, ".github/workflows/ext-blt.yml\n", ""),
			fetch: async () => checkRunResponse("in_progress", null),
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		};
		await expect(gate(options, deps)).rejects.toThrow(
			"timed out waiting for: ext-blt",
		);
	});
});

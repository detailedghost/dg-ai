import { describe, expect, test } from "bun:test";
import { SUPPORTED_PLATFORMS } from "./supported-platforms";
import { readRepoFile } from "./test-support";
import { parseWorkflow, workflowText } from "./workflow-support";

const release = parseWorkflow("release.yml");

function workflow(name: string): string {
	return workflowText(name);
}

describe("the dg-daemon build workflow is path-filtered to its own packages", () => {
	test("the build workflow fires on dg-daemon and common, and on itself", () => {
		const blt = workflow("dg-daemon-blt.yml");
		expect(blt).toContain("pkg/dg-daemon/**");
		expect(blt).toContain("pkg/common/**");
		expect(blt).toContain(".github/workflows/dg-daemon-blt.yml");
	});

	test("the build workflow does not fire on unrelated packages", () => {
		const blt = workflow("dg-daemon-blt.yml");
		expect(blt).not.toContain("pkg/extension/**");
		expect(blt).not.toContain("pkg/skills-cli/**");
		expect(blt).not.toContain("plugins/dg/skills/**");
	});
});

type RuntimeJson = {
	version: string;
	assets: Record<string, { file: string; sha256: string }>;
};

const runtime = JSON.parse(readRepoFile("pkg", "launcher", "runtime.json")) as RuntimeJson;
const releaseText = workflow("release.yml");

function smokeMatrix(): Array<Record<string, string>> {
	const id = Object.keys(release.jobs).find((job) => job.startsWith("smoke"));
	return release.jobs[id ?? ""]?.strategy?.matrix?.include ?? [];
}

describe("the release ships one platform-independent bundle, not compiled binaries", () => {
	test("release.yml compiles nothing and names no per-platform dg binary", () => {
		expect(releaseText).not.toContain("--compile");
		expect(releaseText).not.toMatch(/dg-(skills|daemon|agent)-(linux|macos|windows)/);
	});

	test("exactly one job builds the bundle", () => {
		const builders = Object.keys(release.jobs).filter(
			(id) => id.startsWith("build-") && id !== "build-ext" && id !== "build-narration",
		);

		expect(builders).toEqual(["build-bundle"]);
	});

	test("no build workflow compiles a binary either", () => {
		for (const name of ["skills-blt.yml", "dg-agent-blt.yml", "dg-daemon-blt.yml"]) {
			expect(workflow(name)).not.toContain("--compile");
		}
	});
});

describe("the runtime pin and the smoke matrix cover the same platforms", () => {
	const keys = Object.keys(runtime.assets).filter((key) => !key.endsWith("-baseline"));

	test("every supported platform has a pinned bun asset with a sha256", () => {
		expect(keys.sort()).toEqual(SUPPORTED_PLATFORMS.map((p) => p.runtimeKey).sort());
		for (const asset of Object.values(runtime.assets)) {
			expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(asset.file).toMatch(/^bun-[a-z0-9-]+\.zip$/);
		}
	});

	test("every pinned platform is smoked on a runner of its own platform", () => {
		const matrix = smokeMatrix();

		for (const { runtimeKey, runners } of SUPPORTED_PLATFORMS) {
			expect(runtime.assets[runtimeKey]).toBeDefined();
			expect(matrix.filter((entry) => runners.includes(entry.os)).length).toBe(1);
		}
		expect(matrix.length).toBe(SUPPORTED_PLATFORMS.length);
	});
});

describe("the retired dg-server name reaches no new release", () => {
	test("the release publishes no alias and no renamed copies", () => {
		expect(releaseText).not.toContain("server-v");
		expect(releaseText).not.toContain("dg-server");
		expect(releaseText).not.toContain("legacy");
	});
});

describe("the bootstrap scripts install the runtime pin and the bundle, then delegate to install", () => {
	const sh = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
	const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");

	for (const [name, source] of [["bootstrap.sh", sh], ["bootstrap.ps1", ps1]] as const) {
		test(`${name} reads runtime.json, fetches the bundle tarball and never a compiled binary`, () => {
			expect(source).toContain("runtime.json");
			expect(source).toContain("dg-lib-");
			expect(source).toContain("SHA256SUMS");
			expect(source).not.toContain("dg-daemon-linux");
			expect(source).not.toContain("dg-daemon-windows");
			expect(source).not.toContain("dg-skills-linux");
			expect(source).not.toContain("dg-skills-windows");
		});

		test(`${name} downloads bun from oven-sh and links runtime and lib current`, () => {
			expect(source).toContain("oven-sh/bun");
			expect(source).toMatch(/runtime/);
			expect(source).toMatch(/current/);
		});
	}

	test("bootstrap.sh links runtime/current and lib/current by name", () => {
		expect(sh).toContain("runtime/current");
		expect(sh).toContain("lib/current");
	});

	test("bootstrap.sh ends by calling the dg-skills shim with install", () => {
		expect(sh).toMatch(/bin\/dg-skills"?\s+install/);
	});

	test("bootstrap.ps1 uses Expand-Archive, Get-FileHash and directory junctions", () => {
		expect(ps1).toContain("Expand-Archive");
		expect(ps1).toContain("Get-FileHash");
		expect(ps1).toMatch(/New-Item\s+-ItemType\s+Junction/);
	});

	test("bootstrap.ps1 writes .cmd shims for the three programs and appends the bin dir to the user PATH once", () => {
		expect(ps1).toContain(".cmd");
		for (const program of ["dg-skills", "dg-agent", "dg-daemon"]) {
			expect(ps1).toContain(program);
		}
		expect(ps1).toMatch(/SetEnvironmentVariable\([^)]*"?User"?\)/);
		expect(ps1).toMatch(/-notcontains|-notlike|-contains|\.Contains\(/);
	});
});

describe("the skills build gives the verify harness what it needs", () => {
	test("the skills-cli test step turns off the browser sandbox the runner cannot provide", () => {
		const blt = workflow("skills-blt.yml");
		const step =
			/- name: Test \(skills-cli\)[\s\S]*?(?=\n {6}- name:|\n {2}\S|$)/.exec(
				blt,
			)?.[0];

		expect(step).toBeDefined();
		expect(step).toContain("DG_VERIFY_NO_SANDBOX");
		expect(step).toContain(
			"bun test --shard=${{ matrix.shard }}/${{ strategy.job-total }}",
		);
	});

	test("the extension is built before the skills-cli tests that load it", () => {
		const names = [
			...workflow("skills-blt.yml").matchAll(/- name: ([^\n]+)/g),
		].map((m) => m[1]);
		const built = names.findIndex((n) => n.startsWith("Build (extension"));
		const tested = names.findIndex((n) => n.startsWith("Test (skills-cli)"));

		expect(built).toBeGreaterThan(-1);
		expect(tested).toBeGreaterThan(built);
	});

	test("the harness reads that same variable name", () => {
		const harness = readRepoFile(
			"pkg",
			"skills-cli",
			"src",
			"utils",
			"cdp-harness.ts",
		);

		expect(harness).toContain("env.DG_VERIFY_NO_SANDBOX");
		expect(harness).toContain('"--no-sandbox"');
	});
});

import { describe, expect, test } from "bun:test";
import { cliAssetName } from "@dg/skills-cli/lib";
import { SUPPORTED_PLATFORMS } from "./supported-platforms";
import { readRepoFile } from "./test-support";
import { parseWorkflow, workflowText } from "./workflow-support";

const release = parseWorkflow("release.yml");

function workflow(name: string): string {
	return workflowText(name);
}

function matrixOf(job: string): Array<Record<string, string>> {
	return release.jobs[job]?.strategy?.matrix?.include ?? [];
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

type ReleasedBinary = {
	binaryName: string;
	job: string;
};

const RELEASED_BINARIES: ReleasedBinary[] = [
	{ binaryName: "dg-skills", job: "skills" },
	{ binaryName: "dg-daemon", job: "daemon" },
	{ binaryName: "dg-agent", job: "agent" },
];

/**
 * Runner labels that execute each target natively. Apple Silicon labels carry no
 * "arm" in their name, so the mapping is spelled out rather than pattern-matched.
 */
const NATIVE_RUNNERS: Record<string, string[]> = {
	"linux-x64": ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"],
	"linux-arm64": ["ubuntu-24.04-arm", "ubuntu-22.04-arm", "ubuntu-latest-arm"],
	"darwin-x64": ["macos-15-intel"],
	"darwin-arm64": ["macos-14", "macos-15", "macos-latest"],
	"win32-x64": ["windows-latest", "windows-2022", "windows-2025"],
	"win32-arm64": ["windows-11-arm"],
};

for (const { binaryName, job } of RELEASED_BINARIES) {
	describe(`${binaryName}: the release matrix and the install resolver agree, asset for asset`, () => {
		const built = matrixOf(`build-${job}`).map((entry) => entry.asset);
		const smoked = matrixOf(`smoke-${job}`);

		test("every asset the resolver can ask for is published by the matrix", () => {
			for (const { platform, arch } of SUPPORTED_PLATFORMS) {
				const name = cliAssetName(binaryName, platform, arch);
				expect(name).toBeDefined();
				expect(built).toContain(name as string);
			}
		});

		test("the matrix publishes nothing the resolver cannot name", () => {
			const resolvable = new Set(
				SUPPORTED_PLATFORMS.map(({ platform, arch }) =>
					cliAssetName(binaryName, platform, arch),
				),
			);

			expect(new Set(built).size).toBe(SUPPORTED_PLATFORMS.length);
			for (const asset of built) expect(resolvable.has(asset)).toBe(true);
		});

		test("every published binary is executed on a runner of its own platform", () => {
			expect(smoked.length).toBe(SUPPORTED_PLATFORMS.length);

			for (const { platform, arch } of SUPPORTED_PLATFORMS) {
				const asset = cliAssetName(binaryName, platform, arch);
				const runner = smoked.find((entry) => entry.asset === asset)?.os ?? "";
				expect(NATIVE_RUNNERS[`${platform}-${arch}`]).toContain(runner);
			}
		});

		test("the smoke matrix runs exactly the assets the build matrix produces", () => {
			expect(smoked.map((entry) => entry.asset).sort()).toEqual([...built].sort());
		});
	});
}

describe("the retired dg-server name reaches no new release", () => {
	test("the release publishes no alias and no renamed copies", () => {
		const rel = workflow("release.yml");

		expect(rel).not.toContain("server-v");
		expect(rel).not.toContain("dg-server");
		expect(rel).not.toContain("legacy");
	});
});

describe("the skills CLI presents itself under its shipped name", () => {
	const entry = readRepoFile("pkg", "skills-cli", "src", "index.ts");
	const shipped = matrixOf("build-skills")[0]?.asset.replace(
		/-(linux|macos|windows)-.*$/,
		"",
	);

	test("the program name and the release asset name are the same word", () => {
		expect(shipped).toBeDefined();
		expect(/\.name\("([^"]+)"\)/.exec(entry)?.[1]).toBe(shipped);
	});

	test("a top-level failure is prefixed with that same name", () => {
		expect(entry).toContain(`console.error(\`${shipped}: `);
	});
});

describe("install refreshes every prebuilt binary through one fetcher", () => {
	const install = readRepoFile(
		"pkg",
		"skills-cli",
		"src",
		"commands",
		"install.ts",
	);

	const declared =
		/const BINARIES: BinarySpec\[\] = \[([\s\S]*?)\];/.exec(install)?.[1] ??
		"";
	const declaredNames = [...declared.matchAll(/"(dg-[a-z]+)"/g)].map((m) => m[1]);

	test("every released binary is declared once, and no others are", () => {
		expect(declaredNames.sort()).toEqual(
			RELEASED_BINARIES.map((b) => b.binaryName).sort(),
		);
	});

	test("the command description names every binary it refreshes", () => {
		const description = /\.description\(\s*"([^"]*refresh[^"]*)"/.exec(
			install,
		)?.[1];

		expect(declaredNames.length).toBe(RELEASED_BINARIES.length);
		expect(description).toBeDefined();
		for (const name of declaredNames) {
			expect(description).toContain(name);
		}
	});

	test("the daemon and the agent are installed into the same directory, so sibling resolution finds one from the other", () => {
		const lib = readRepoFile("pkg", "skills-cli", "src", "utils", "lib.ts");
		const dest = /export function cliDest[\s\S]*?\n}/.exec(lib)?.[0];

		expect(dest).toContain("join(cliBinDir(), name)");
		expect(dest).not.toContain("binaryName ===");
	});

	test("the fetch is written once, not duplicated per binary", () => {
		expect([...install.matchAll(/fetchCliBinary\(/g)].length).toBe(1);
		expect([...install.matchAll(/resolveCliAsset\(/g)].length).toBe(1);
	});

	test("the already-current skip and the warn-and-continue path both survive", () => {
		expect(install).toMatch(/already\s+current/);
		expect(install).toMatch(/skipping\s+its\s+refresh/);
		expect(install).toContain("console.warn");
	});

	test("the not-found warning distinguishes an unbuilt platform from an unpublished release", () => {
		expect(install).toContain("describeMissingCliAsset(spec, releases)");
		expect(install).toMatch(/has no published asset/);
		expect(install).toMatch(/no\s+(vX\.Y\.Z\s+)?release/);
	});
});

describe("the bootstrap scripts reach dg-daemon through install, not a second curl loop", () => {
	test("bootstrap.sh ends by calling install rather than fetching dg-daemon itself", () => {
		const sh = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
		expect(sh).toMatch(/"\$\{INSTALLER\}"\s+install/);
		expect(sh).not.toContain("dg-daemon-linux");
		expect(sh).not.toContain("dg-daemon-windows");
	});

	test("bootstrap.ps1 likewise delegates rather than duplicating the fetch", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		expect(ps1).toMatch(/&\s+\$installer\s+install/);
		expect(ps1).not.toContain("dg-daemon-linux");
		expect(ps1).not.toContain("dg-daemon-windows");
	});

	test("the fetcher marks what it downloads executable, so both binaries are runnable", () => {
		const lib = readRepoFile("pkg", "skills-cli", "src", "utils", "lib.ts");
		const fn = /export function commitCliBinary[\s\S]*?\n}/.exec(lib)?.[0];

		expect(fn).toMatch(/chmodSync\(staging, 0o755\)/);
		expect(fn?.indexOf("chmodSync(staging")).toBeLessThan(
			fn?.indexOf("renameSync(staging, dest)") ?? -1,
		);
	});

	test("bootstrap.sh never downloads straight over a binary that may be running", () => {
		const sh = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
		expect(sh).not.toMatch(/-o\s+"\$\{DEST\}"/);
		expect(sh).toMatch(/mv -f "\$\{INSTALLER\}" "\$\{DEST\}"/);
	});

	test("bootstrap.ps1 renames a running dg-skills.exe aside instead of writing over it", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		expect(ps1).not.toMatch(/-OutFile \$dest\b/);
		expect(ps1).toMatch(/\$old = "\$dest\.old-" \+ \[guid\]::NewGuid\(\)/);
		expect(ps1).toMatch(/Move-Item -LiteralPath \$dest -Destination \$old/);
		expect(ps1).toMatch(/Move-Item -LiteralPath \$installer -Destination \$dest/);
		expect(ps1).toMatch(/Move-Item -LiteralPath \$old -Destination \$dest/);
		expect(ps1).not.toMatch(/Remove-Item -Path/);
		expect(ps1).toMatch(/Get-ChildItem -LiteralPath \$binDir -File/);
		const swap = ps1.indexOf("Move-Item -LiteralPath $installer -Destination $dest");
		const cleanup = ps1.indexOf("Get-ChildItem -LiteralPath $binDir -File");
		expect(cleanup).toBeGreaterThan(swap);
		const lock = ps1.indexOf("[System.IO.File]::Open($lockPath");
		const stamp = ps1.indexOf('".dg-skills.version"');
		const release = ps1.indexOf("$swapLock.Dispose()");
		expect(ps1).not.toContain("Mutex");
		expect(ps1).toMatch(/\$lockPath = Join-Path \(Resolve-Path -LiteralPath \$binDir\)\.ProviderPath "\.dg-skills-swap\.lock"/);
		expect(lock).toBeGreaterThan(-1);
		expect(lock).toBeLessThan(swap);
		expect(stamp).toBeGreaterThan(cleanup);
		expect(release).toBeGreaterThan(stamp);
	});

	test("bootstrap.ps1 never hands a pinned install off to the binary it just downloaded", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		expect(ps1).toMatch(/installer-.*NewGuid.*\.exe/);
		expect(ps1).not.toMatch(/&\s+\$dest\s+install/);
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

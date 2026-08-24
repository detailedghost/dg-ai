import { describe, expect, test } from "bun:test";
import { cliAssetName } from "@dg/skills-cli/lib";
import { SUPPORTED_PLATFORMS } from "./supported-platforms";
import { readRepoFile } from "./test-support";

function workflow(name: string): string {
	return readRepoFile(".github", "workflows", name);
}

describe("the dg-server workflows are path-filtered to their own packages", () => {
	test("the build workflow fires on dg-server and common, and on itself", () => {
		const blt = workflow("dg-server-blt.yml");
		expect(blt).toContain("pkg/dg-server/**");
		expect(blt).toContain("pkg/common/**");
		expect(blt).toContain(".github/workflows/dg-server-blt.yml");
	});

	test("the build workflow does not fire on unrelated packages", () => {
		const blt = workflow("dg-server-blt.yml");
		expect(blt).not.toContain("pkg/extension/**");
		expect(blt).not.toContain("pkg/skills-cli/**");
		expect(blt).not.toContain("plugins/dg/skills/**");
	});

	test("the release workflow carries the same filter and gates on the build workflow", () => {
		const rel = workflow("dg-server-release.yml");
		expect(rel).toContain("pkg/dg-server/**");
		expect(rel).toContain("pkg/common/**");
		expect(rel).toContain("uses: ./.github/workflows/dg-server-blt.yml");
		expect(rel).not.toContain("pkg/extension/**");
		expect(rel).not.toContain("pkg/skills-cli/**");
	});

	test("a change under pkg/dg-server does not fire the skills workflow", () => {
		const skills = workflow("skills-blt.yml");
		expect(skills).not.toContain("pkg/dg-server/**");
	});
});

describe("the release matrix and the install resolver agree, asset for asset", () => {
	test("every asset the resolver can ask for is published by the matrix", () => {
		const rel = workflow("dg-server-release.yml");
		for (const { platform, arch } of SUPPORTED_PLATFORMS) {
			const name = cliAssetName("dg-server", platform, arch);
			expect(name).toBeDefined();
			expect(rel).toContain(`asset: ${name}`);
		}
	});

	test("the matrix publishes nothing the resolver cannot name", () => {
		const rel = workflow("dg-server-release.yml");
		const declared = [...rel.matchAll(/asset:\s*(\S+)/g)].map((m) => m[1]);
		const resolvable = new Set(
			SUPPORTED_PLATFORMS.map(({ platform, arch }) =>
				cliAssetName("dg-server", platform, arch),
			),
		);
		expect(declared.length).toBe(SUPPORTED_PLATFORMS.length);
		for (const asset of declared) expect(resolvable.has(asset)).toBe(true);
	});

	test("the release tag prefix is server-v, which is what install passes", () => {
		const rel = workflow("dg-server-release.yml");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell tag text from the workflow, not a JS interpolation
		expect(rel).toContain('tag="server-v${version}"');
		expect(
			readRepoFile("pkg", "skills-cli", "src", "commands", "install.ts"),
		).toContain('tagPrefix: "server-v"');
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

	test("both binaries are declared with their own tag prefix", () => {
		expect(install).toContain('binaryName: "dg-skills"');
		expect(install).toContain('tagPrefix: "skills-v"');
		expect(install).toContain('binaryName: "dg-server"');
		expect(install).toContain('tagPrefix: "server-v"');
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
});

describe("the bootstrap scripts reach dg-server through install, not a second curl loop", () => {
	test("bootstrap.sh ends by calling install rather than fetching dg-server itself", () => {
		const sh = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
		expect(sh).toMatch(/"\$\{DEST\}"\s+install/);
		expect(sh).not.toContain("dg-server-linux");
		expect(sh).not.toContain("dg-server-windows");
	});

	test("bootstrap.ps1 likewise delegates rather than duplicating the fetch", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		expect(ps1).toMatch(/&\s+\$dest\s+install/);
		expect(ps1).not.toContain("dg-server-linux");
		expect(ps1).not.toContain("dg-server-windows");
	});

	test("the fetcher marks what it downloads executable, so both binaries are runnable", () => {
		expect(
			readRepoFile("pkg", "skills-cli", "src", "utils", "lib.ts"),
		).toContain("chmodSync(dest, 0o755)");
	});
});

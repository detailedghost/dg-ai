import { describe, expect, test } from "bun:test";
import { cliAssetName } from "@dg/skills-cli/lib";
import { SUPPORTED_PLATFORMS } from "./supported-platforms";
import { readRepoFile } from "./test-support";

function workflow(name: string): string {
	return readRepoFile(".github", "workflows", name);
}

describe("the dg-daemon workflows are path-filtered to their own packages", () => {
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

	test("the release workflow carries the same filter and gates on the build workflow", () => {
		const rel = workflow("dg-daemon-release.yml");
		expect(rel).toContain("pkg/dg-daemon/**");
		expect(rel).toContain("pkg/common/**");
		expect(rel).toContain("uses: ./.github/workflows/dg-daemon-blt.yml");
		expect(rel).not.toContain("pkg/extension/**");
		expect(rel).not.toContain("pkg/skills-cli/**");
	});

	test("a change under pkg/dg-daemon does not fire the skills workflow", () => {
		const skills = workflow("skills-blt.yml");
		expect(skills).not.toContain("pkg/dg-daemon/**");
	});
});

type ReleasedBinary = {
	binaryName: string;
	workflow: string;
	tagPrefix: string;
};

const RELEASED_BINARIES: ReleasedBinary[] = [
	{
		binaryName: "dg-skills",
		workflow: "skills-release.yml",
		tagPrefix: "skills-v",
	},
	{
		binaryName: "dg-daemon",
		workflow: "dg-daemon-release.yml",
		tagPrefix: "daemon-v",
	},
	{
		binaryName: "dg-agent",
		workflow: "dg-agent-release.yml",
		tagPrefix: "agent-v",
	},
];

for (const {
	binaryName,
	workflow: workflowFile,
	tagPrefix,
} of RELEASED_BINARIES) {
	describe(`${binaryName}: the release matrix and the install resolver agree, asset for asset`, () => {
		test("every asset the resolver can ask for is published by the matrix", () => {
			const rel = workflow(workflowFile);

			for (const { platform, arch } of SUPPORTED_PLATFORMS) {
				const name = cliAssetName(binaryName, platform, arch);
				expect(name).toBeDefined();
				expect(rel).toContain(`asset: ${name}`);
			}
		});

		test("the matrix publishes nothing the resolver cannot name", () => {
			const rel = workflow(workflowFile);
			const declared = [...rel.matchAll(/asset:\s*(\S+)/g)].map((m) => m[1]);
			const resolvable = new Set(
				SUPPORTED_PLATFORMS.map(({ platform, arch }) =>
					cliAssetName(binaryName, platform, arch),
				),
			);

			expect(declared.length).toBe(SUPPORTED_PLATFORMS.length);
			for (const asset of declared) expect(resolvable.has(asset)).toBe(true);
		});

		test("install asks for the tag prefix this workflow publishes", () => {
			expect(workflow(workflowFile)).toContain(tagPrefix);
			expect(
				readRepoFile("pkg", "skills-cli", "src", "commands", "install.ts"),
			).toContain(`tagPrefix: "${tagPrefix}"`);
		});
	});
}

describe("the retired dg-server name reaches no new release", () => {
	test("the daemon release publishes only its own tag, with no alias and no renamed copies", () => {
		const rel = workflow("dg-daemon-release.yml");

		expect(rel).toContain('tag="daemon-v');
		expect(rel).not.toContain("server-v");
		expect(rel).not.toContain("dg-server");
		expect(rel).not.toContain("legacy");
	});

	test("the agent release publishes no alias, having never shipped under another name", () => {
		const rel = workflow("dg-agent-release.yml");

		expect(rel).not.toContain("dg-server");
		expect(rel).not.toContain("legacy");
	});
});

describe("the skills CLI presents itself under its shipped name", () => {
	const entry = readRepoFile("pkg", "skills-cli", "src", "index.ts");
	const shipped = RELEASED_BINARIES.find(
		(b) => b.workflow === "skills-release.yml",
	)?.binaryName;

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

	test("every released binary is declared with its own tag prefix, and no others are", () => {
		const declared = /const BINARIES: BinarySpec\[\] = \[([\s\S]*?)\];/.exec(
			install,
		)?.[1];

		for (const { binaryName, tagPrefix } of RELEASED_BINARIES) {
			expect(declared).toContain(`binaryName: "${binaryName}"`);
			expect(declared).toContain(`tagPrefix: "${tagPrefix}"`);
		}
		expect([...(declared ?? "").matchAll(/binaryName:/g)].length).toBe(
			RELEASED_BINARIES.length,
		);
	});

	test("the command description names every binary it refreshes", () => {
		const declared =
			/const BINARIES: BinarySpec\[\] = \[([\s\S]*?)\];/.exec(install)?.[1] ??
			"";
		const names = [...declared.matchAll(/binaryName: "([^"]+)"/g)].map(
			(m) => m[1],
		);
		const description = /\.description\(\s*"([^"]*refresh[^"]*)"/.exec(
			install,
		)?.[1];

		expect(names.length).toBe(RELEASED_BINARIES.length);
		expect(description).toBeDefined();
		for (const name of names) {
			expect(description).toContain(name);
		}
	});

	test("the daemon and the agent are installed into the same directory, so sibling resolution finds one from the other", () => {
		const lib = readRepoFile("pkg", "skills-cli", "src", "utils", "lib.ts");
		const dest = /export function cliDest[\s\S]*?\n}/.exec(lib)?.[0];

		expect(dest).toContain('join(homedir(), ".dg", "bin"');
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
		expect(install).toMatch(/no release with tag prefix/);
	});
});

describe("the bootstrap scripts reach dg-daemon through install, not a second curl loop", () => {
	test("bootstrap.sh ends by calling install rather than fetching dg-daemon itself", () => {
		const sh = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
		expect(sh).toMatch(/"\$\{DEST\}"\s+install/);
		expect(sh).not.toContain("dg-daemon-linux");
		expect(sh).not.toContain("dg-daemon-windows");
	});

	test("bootstrap.ps1 likewise delegates rather than duplicating the fetch", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		expect(ps1).toMatch(/&\s+\$dest\s+install/);
		expect(ps1).not.toContain("dg-daemon-linux");
		expect(ps1).not.toContain("dg-daemon-windows");
	});

	test("the fetcher marks what it downloads executable, so both binaries are runnable", () => {
		const lib = readRepoFile("pkg", "skills-cli", "src", "utils", "lib.ts");
		const fn = /export async function fetchCliBinary[\s\S]*?\n}/.exec(lib)?.[0];

		expect(fn).toMatch(/chmodSync\(staging, 0o755\)/);
		expect(fn?.indexOf("chmodSync(staging")).toBeLessThan(
			fn?.indexOf("renameSync(staging, dest)") ?? -1,
		);
	});
});

describe("the skills build gives the verify harness what it needs", () => {
	test("the skills-cli test step turns off the browser sandbox the runner cannot provide", () => {
		const blt = workflow("skills-blt.yml");
		const step =
			/- name: Test \(skills-cli\)[\s\S]*?(?=\n {6}- name:)/.exec(blt)?.[0];

		expect(step).toBeDefined();
		expect(step).toContain("DG_VERIFY_NO_SANDBOX");
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

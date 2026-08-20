/**
 * dg-server's release pipeline and its install path: the workflow matrix, the
 * resolver that has to agree with it, and the bootstrap tail that must not grow
 * a second fetcher.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cliAssetName } from "@dg/skills-cli/lib";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");

function workflow(name: string): string {
	return readFileSync(join(WORKFLOWS, name), "utf8");
}

function source(...parts: string[]): string {
	return readFileSync(join(REPO_ROOT, ...parts), "utf8");
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
	const platforms: [string, string][] = [
		["linux", "x64"],
		["linux", "arm64"],
		["darwin", "x64"],
		["darwin", "arm64"],
		["win32", "x64"],
		["win32", "arm64"],
	];

	test("every asset the resolver can ask for is published by the matrix", () => {
		const rel = workflow("dg-server-release.yml");
		for (const [platform, arch] of platforms) {
			const name = cliAssetName("dg-server", platform, arch);
			expect(name).toBeDefined();
			expect(rel).toContain(`asset: ${name}`);
		}
	});

	test("the matrix publishes nothing the resolver cannot name", () => {
		const rel = workflow("dg-server-release.yml");
		const declared = [...rel.matchAll(/asset:\s*(\S+)/g)].map((m) => m[1]);
		const resolvable = new Set(
			platforms.map(([p, a]) => cliAssetName("dg-server", p, a)),
		);
		expect(declared.length).toBe(platforms.length);
		for (const asset of declared) expect(resolvable.has(asset)).toBe(true);
	});

	test("the release tag prefix is server-v, which is what install passes", () => {
		expect(workflow("dg-server-release.yml")).toContain('tag="server-v${version}"');
		expect(source("pkg", "skills-cli", "src", "commands", "install.ts")).toContain(
			'tagPrefix: "server-v"',
		);
	});
});

describe("install refreshes every prebuilt binary through one fetcher", () => {
	const install = source("pkg", "skills-cli", "src", "commands", "install.ts");

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
		const sh = source("pkg", "skills-cli", "bootstrap.sh");
		expect(sh).toMatch(/"\$\{DEST\}"\s+install/);
		expect(sh).not.toContain("dg-server-linux");
		expect(sh).not.toContain("dg-server-windows");
	});

	test("bootstrap.ps1 likewise delegates rather than duplicating the fetch", () => {
		const ps1 = source("pkg", "skills-cli", "bootstrap.ps1");
		expect(ps1).toMatch(/&\s+\$dest\s+install/);
		expect(ps1).not.toContain("dg-server-linux");
		expect(ps1).not.toContain("dg-server-windows");
	});

	test("the fetcher marks what it downloads executable, so both binaries are runnable", () => {
		expect(source("pkg", "skills-cli", "src", "utils", "lib.ts")).toContain(
			"chmodSync(dest, 0o755)",
		);
	});
});

describe("the chat SKILL.md does not drift from the daemon's real surface", () => {
	const skill = readFileSync(
		join(REPO_ROOT, "plugins", "dg", "skills", "chat", "SKILL.md"),
		"utf8",
	);
	const errors = source("pkg", "dg-server", "src", "server", "errors.ts");
	const agentCmds = source("pkg", "dg-server", "src", "commands", "index.ts");
	const entry = source("pkg", "dg-server", "src", "index.ts");

	function declaredCommands(...sources: string[]): string[] {
		return sources
			.flatMap((src) => [...src.matchAll(/\.command\("([^"]+)"/g)])
			.map((m) => m[1])
			.filter((name) => !name.startsWith("__"));
	}

	test("every non-hidden command the CLI registers is documented", () => {
		const commands = declaredCommands(agentCmds, entry);
		expect(commands.length).toBeGreaterThan(5);
		for (const name of commands) {
			expect(skill).toMatch(new RegExp(`\`${name}[ \`]`));
		}
	});

	test("every exit code the daemon defines is listed with its number", () => {
		const codes = [...errors.matchAll(/EXIT_([A-Z_]+)\s*=\s*(\d+)/g)].map(
			(m) => m[2],
		);
		expect(codes.length).toBeGreaterThan(4);
		for (const code of codes) {
			expect(skill).toMatch(new RegExp(`\\|\\s*${code}\\s*\\|`));
		}
	});

	test("the reserved recv timeout code is documented as the loop-on signal", () => {
		const timeout = errors.match(/EXIT_RECV_TIMEOUT\s*=\s*(\d+)/)?.[1];
		expect(timeout).toBeDefined();
		expect(skill).toMatch(
			new RegExp(`Code\\s+${timeout}\\s+is\\s+the\\s+one\\s+to\\s+branch\\s+on`),
		);
	});

	test("every flag the recv, progress and manifest commands take is documented", () => {
		for (const flag of [
			"--block",
			"--timeout",
			"--state",
			"--commands",
			"--subagents",
			"--workset",
			"--orchestrator",
			"--open",
		]) {
			expect(skill).toContain(flag);
		}
	});

	test("the documented recv timeout default matches the CLI's own default", () => {
		const def = agentCmds.match(/DEFAULT_RECV_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1];
		expect(def).toBeDefined();
		const ms = Number((def as string).replace(/_/g, ""));
		expect(skill).toMatch(new RegExp(`${ms}\\s*ms`));
	});

	test("progress states are documented exactly as the CLI validates them", () => {
		expect(agentCmds).toContain('options.state !== "running"');
		expect(agentCmds).toContain('options.state !== "awaiting-input"');
		expect(skill).toMatch(/running\|awaiting-input/);
	});
});

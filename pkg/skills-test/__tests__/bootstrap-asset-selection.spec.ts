import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const BOOTSTRAP = join(REPO_ROOT, "pkg", "skills-cli", "bootstrap.sh");

function extractSelection(): string {
	const lines = readFileSync(BOOTSTRAP, "utf8").split("\n");
	const start = lines.findIndex((l) => l.startsWith("tag=$(printf"));
	if (start === -1) throw new Error("bootstrap.sh tag resolution not found");
	const urlStart = lines.findIndex(
		(l, i) => i > start && l.startsWith("url=$("),
	);
	if (urlStart === -1) throw new Error("bootstrap.sh url resolution not found");
	const end = lines.findIndex(
		(l, i) => i > urlStart && l.trim() === "head -1)",
	);
	if (end === -1) throw new Error("bootstrap.sh url resolution never closed");
	return lines.slice(start, end + 1).join("\n");
}

function release(
	tag: string,
	assets: string[],
	draft = false,
): Record<string, unknown> {
	return {
		tag_name: tag,
		draft,
		prerelease: false,
		assets: assets.map((name) => ({
			name,
			browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`,
		})),
	};
}

function pick(releases: Record<string, unknown>[], asset: string): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-bootstrap-test-"));
	const jsonPath = join(dir, "releases.json");
	writeFileSync(jsonPath, JSON.stringify(releases));
	const script = `set -eu
asset="${asset}"
releases=$(cat "${jsonPath}")
${extractSelection()}
printf '%s\\n' "\${url}"
`;
	const proc = Bun.spawnSync(["sh", "-c", script]);
	return new TextDecoder().decode(proc.stdout).trim();
}

const SKILLS_ASSET = "dg-skills-linux-x64";

describe("bootstrap.sh picks its binary from the skills-v* tag only", () => {
	test("resolves the asset from a skills-v* release", () => {
		const url = pick(
			[release("skills-v1.0.0", [SKILLS_ASSET, "dg-skills-macos-arm64"])],
			SKILLS_ASSET,
		);
		expect(url).toContain("/skills-v1.0.0/");
		expect(url.endsWith(`/${SKILLS_ASSET}`)).toBe(true);
	});

	test("refuses an identically-named asset attached to a NEWER non-skills release", () => {
		const url = pick(
			[
				release("ext-v9.9.9", [SKILLS_ASSET]),
				release("daemon-v9.9.9", [SKILLS_ASSET]),
				release("skills-v1.0.0", [SKILLS_ASSET]),
			],
			SKILLS_ASSET,
		);
		expect(url).toContain("/skills-v1.0.0/");
		expect(url).not.toContain("ext-v9.9.9");
		expect(url).not.toContain("daemon-v9.9.9");
	});

	test("takes the first skills-v* tag in listing order, which unauthenticated callers only ever see published", () => {
		const url = pick(
			[
				release("skills-v2.0.0", [SKILLS_ASSET]),
				release("skills-v1.0.0", [SKILLS_ASSET]),
			],
			SKILLS_ASSET,
		);
		expect(url).toContain("/skills-v2.0.0/");
	});

	test("the sibling installers filter drafts explicitly, since they can run authenticated", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		const lib = readRepoFile("pkg", "skills-cli", "src", "utils", "lib.ts");
		expect(ps1).toMatch(/-not\s+\$_\.draft/);
		expect(lib).toMatch(/!r\.draft/);
	});

	test("resolves nothing when only non-skills releases carry the asset name", () => {
		expect(pick([release("ext-v1.0.0", [SKILLS_ASSET])], SKILLS_ASSET)).toBe(
			"",
		);
	});

	test("does not match an asset whose name merely ends with the wanted one", () => {
		const url = pick(
			[release("skills-v1.0.0", [`evil-${SKILLS_ASSET}`])],
			SKILLS_ASSET,
		);
		expect(url).toBe("");
	});

	test("picks the newest skills-v* release when several are published", () => {
		const url = pick(
			[
				release("skills-v3.1.0", [SKILLS_ASSET]),
				release("skills-v1.0.0", [SKILLS_ASSET]),
			],
			SKILLS_ASSET,
		);
		expect(url).toContain("/skills-v3.1.0/");
	});
});

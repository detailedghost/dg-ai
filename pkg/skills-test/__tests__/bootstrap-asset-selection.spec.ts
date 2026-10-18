import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const BOOTSTRAP = join(REPO_ROOT, "pkg", "skills-cli", "bootstrap.sh");

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

function filler(n: number, prefix = "ext-v0.0."): Record<string, unknown>[] {
	return Array.from({ length: n }, (_, i) => release(`${prefix}${i}`, []));
}

const CURL_STUB = `#!/bin/sh
outfile=""
prev=""
url=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then outfile="$a"; fi
  url="$a"
  prev="$a"
done
case "$url" in
*/releases\\?*)
  n=$(($(cat "$COUNTER") + 1))
  printf '%s' "$n" > "$COUNTER"
  f="$STUBDIR/page$n.json"
  if [ -f "$f" ]; then cat "$f"; else printf '[]'; fi
  ;;
*SHA256SUMS)
  if [ -f "$STUBDIR/SHA256SUMS" ]; then
    cat "$STUBDIR/SHA256SUMS" > "\${outfile:-/dev/stdout}"
  else
    echo "stub missing SHA256SUMS" >&2
    exit 1
  fi
  ;;
*)
  if [ -n "\${INSTALL_BODY:-}" ]; then
    printf '%s\\n' "$INSTALL_BODY" > "\${outfile:-/dev/stdout}"
  else
    printf '#!/bin/sh\\n# %s\\nexit 0\\n' "$url" > "\${outfile:-/dev/stdout}"
  fi
  ;;
esac
`;

type BootstrapRun = {
	code: number;
	stdout: string;
	stderr: string;
	destUrl: string | undefined;
	versionContent: string | undefined;
	pageRequests: number;
};

function fakeBinary(url: string): string {
	return `#!/bin/sh\n# ${url}\nexit 0\n`;
}

async function runBootstrap(
	pages: Record<string, unknown>[][],
	options: { sums?: string; installBody?: string; dgHome?: string; skillsOnly?: boolean } = {},
): Promise<BootstrapRun> {
	const dir = mkdtempSync(join(tmpdir(), "dg-bootstrap-test-"));
	const binDir = join(dir, "stubbin");
	mkdirSync(binDir, { recursive: true });
	pages.forEach((pageReleases, i) => {
		writeFileSync(join(dir, `page${i + 1}.json`), JSON.stringify(pageReleases));
	});
	if (options.sums !== undefined) {
		writeFileSync(join(dir, "SHA256SUMS"), options.sums);
	}
	const counterFile = join(dir, "counter");
	writeFileSync(counterFile, "0");
	writeFileSync(join(binDir, "curl"), CURL_STUB);
	chmodSync(join(binDir, "curl"), 0o755);

	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });

	const skillsSource = join(dir, "skills-src");
	mkdirSync(join(skillsSource, "probe"), { recursive: true });
	writeFileSync(join(skillsSource, "probe", "SKILL.md"), "probe\n");
	const proc = Bun.spawn(["sh", BOOTSTRAP, ...(options.skillsOnly ? ["--skills-only"] : [])], {
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
			HOME: home,
			DG_HOME: options.dgHome ?? "",
			STUBDIR: dir,
			DG_SKILLS_SOURCE: skillsSource,
			DG_SKILLS_DEST: join(dir, "skills-out"),
			COUNTER: counterFile,
			...(options.installBody ? { INSTALL_BODY: options.installBody } : {}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	const binRoot = join(options.dgHome || join(home, ".dg"), "bin");
	const destPath = join(binRoot, "dg-skills");
	const versionPath = join(binRoot, ".dg-skills.version");
	const destContent = existsSync(destPath)
		? readFileSync(destPath, "utf8")
		: undefined;

	return {
		code,
		stdout,
		stderr,
		destUrl: destContent?.split("\n")[1]?.replace(/^#\s*/, ""),
		versionContent: existsSync(versionPath)
			? readFileSync(versionPath, "utf8").trim()
			: undefined,
		pageRequests: Number(readFileSync(counterFile, "utf8").trim()),
	};
}

const SKILLS_ASSET = "dg-skills-linux-x64";

describe("bootstrap.sh picks its binary from the skills-v* tag only", () => {
	test("resolves the asset from a skills-v* release", async () => {
		const run = await runBootstrap([
			[release("skills-v1.0.0", [SKILLS_ASSET, "dg-skills-macos-arm64"])],
		]);
		expect(run.code).toBe(0);
		expect(run.destUrl).toContain("/skills-v1.0.0/");
		expect(run.destUrl?.endsWith(`/${SKILLS_ASSET}`)).toBe(true);
		expect(run.versionContent).toBe("1.0.0");
	});

	test("installs into $DG_HOME/bin when DG_HOME is set", async () => {
		const dgHome = mkdtempSync(join(tmpdir(), "dg-home-"));
		const run = await runBootstrap(
			[[release("skills-v1.0.0", [SKILLS_ASSET])]],
			{ dgHome },
		);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain(`dg-skills installed at ${join(dgHome, "bin", "dg-skills")}`);
		expect(run.versionContent).toBe("1.0.0");
	});

	test("--skills-only installs the verified CLI from skills-v and never runs dg-skills install", async () => {
		const binary = '#!/bin/sh\necho "install ran: $*"\n';
		const sums = `${createHash("sha256").update(binary).digest("hex")}  ${SKILLS_ASSET}\n`;
		const run = await runBootstrap(
			[[release("daemon-v9.0.0", [SKILLS_ASSET]), release("skills-v2.0.0", [SKILLS_ASSET, "SHA256SUMS"])]],
			{ sums, skillsOnly: true, installBody: '#!/bin/sh\necho "install ran: $*"' },
		);
		expect(run.code, run.stderr).toBe(0);
		expect(run.versionContent).toBe("2.0.0");
		expect(run.stdout).toContain("Installed 1 skill files");
		expect(run.stdout).toContain("dg-skills installed at");
		expect(run.stdout).not.toContain("install ran");
		expect(run.stdout).not.toContain("Setting up the dg-ai-extension");
	});

	test("--skills-only refuses a checksum mismatch and keeps no binary", async () => {
		const run = await runBootstrap(
			[[release("skills-v2.0.0", [SKILLS_ASSET, "SHA256SUMS"])]],
			{ sums: `${"0".repeat(64)}  ${SKILLS_ASSET}\n`, skillsOnly: true },
		);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain(`checksum mismatch for ${SKILLS_ASSET}`);
		expect(run.destUrl).toBeUndefined();
	});

	test("refuses an identically-named asset attached to a NEWER non-skills release", async () => {
		const run = await runBootstrap([
			[
				release("ext-v9.9.9", [SKILLS_ASSET]),
				release("daemon-v9.9.9", [SKILLS_ASSET]),
				release("skills-v1.0.0", [SKILLS_ASSET]),
			],
		]);
		expect(run.destUrl).toContain("/skills-v1.0.0/");
		expect(run.destUrl).not.toContain("ext-v9.9.9");
		expect(run.destUrl).not.toContain("daemon-v9.9.9");
	});

	test("takes the first skills-v* tag in listing order, which unauthenticated callers only ever see published", async () => {
		const run = await runBootstrap([
			[
				release("skills-v2.0.0", [SKILLS_ASSET]),
				release("skills-v1.0.0", [SKILLS_ASSET]),
			],
		]);
		expect(run.destUrl).toContain("/skills-v2.0.0/");
	});

	test("the sibling installers filter drafts explicitly, since they can run authenticated", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		const lib = readRepoFile("pkg", "skills-cli", "src", "utils", "lib.ts");
		expect(ps1).toMatch(/-not\s+\$_\.draft/);
		expect(lib).toMatch(/!r\.draft/);
	});

	test("resolves nothing when only non-skills releases carry the asset name", async () => {
		const run = await runBootstrap([[release("ext-v1.0.0", [SKILLS_ASSET])]]);
		expect(run.code).not.toBe(0);
		expect(run.destUrl).toBeUndefined();
	});

	test("does not match an asset whose name merely ends with the wanted one", async () => {
		const run = await runBootstrap([
			[release("skills-v1.0.0", [`evil-${SKILLS_ASSET}`])],
		]);
		expect(run.code).not.toBe(0);
		expect(run.destUrl).toBeUndefined();
	});

	test("picks the newest skills-v* release when several are published", async () => {
		const run = await runBootstrap([
			[
				release("skills-v3.1.0", [SKILLS_ASSET]),
				release("skills-v1.0.0", [SKILLS_ASSET]),
			],
		]);
		expect(run.destUrl).toContain("/skills-v3.1.0/");
	});
});

describe("bootstrap.sh pages past the first release listing", () => {
	test("scans a second page when no skills-v* release appears on the first", async () => {
		const run = await runBootstrap([
			filler(100),
			[release("skills-v1.2.3", [SKILLS_ASSET])],
		]);
		expect(run.pageRequests).toBe(2);
		expect(run.destUrl).toContain("/skills-v1.2.3/");
		expect(run.versionContent).toBe("1.2.3");
	});

	test("stops at the page cap instead of scanning forever when no skills-v* release exists", async () => {
		const run = await runBootstrap(
			Array.from({ length: 12 }, () => filler(100)),
		);
		expect(run.pageRequests).toBe(10);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("1000 releases scanned");
	});
});

describe("bootstrap.sh checksums and the fresh-install message", () => {
	const tag = "skills-v1.0.0";
	const assetUrl = `https://github.com/o/r/releases/download/${tag}/${SKILLS_ASSET}`;

	test("verifies SHA256SUMS when the release publishes it", async () => {
		const hash = createHash("sha256").update(fakeBinary(assetUrl)).digest("hex");
		const run = await runBootstrap([[release(tag, [SKILLS_ASSET, "SHA256SUMS"])]], {
			sums: `${hash}  ${SKILLS_ASSET}\n`,
		});
		expect(run.code, run.stderr).toBe(0);
		expect(run.destUrl).toBe(assetUrl);
		expect(run.stdout).toContain("dg-skills installed");
	});

	test("refuses a checksum mismatch and does not keep the binary", async () => {
		const run = await runBootstrap([[release(tag, [SKILLS_ASSET, "SHA256SUMS"])]], {
			sums: `${"0".repeat(64)}  ${SKILLS_ASSET}\n`,
		});
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("checksum mismatch");
		expect(run.destUrl).toBeUndefined();
		expect(run.versionContent).toBeUndefined();
		expect(run.stdout).not.toContain("dg-skills installed");
	});

	test("refuses a SHA256SUMS file that omits this asset", async () => {
		const run = await runBootstrap([[release(tag, [SKILLS_ASSET, "SHA256SUMS"])]], {
			sums: `${"ab".repeat(32)}  other-binary\n`,
		});
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("no entry");
		expect(run.destUrl).toBeUndefined();
	});

	test("says verified instead of already current after a fresh install", async () => {
		const run = await runBootstrap([[release("skills-v1.12.0", [SKILLS_ASSET])]], {
			installBody: [
				"#!/bin/sh",
				"printf '%s\\n' 'dg-skills already current (v1.12.0).'",
				"printf '%s\\n' 'dg-daemon already current (v1.12.0).'",
				"exit 0",
			].join("\n"),
		});
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("dg-skills verified (v1.12.0).");
		expect(run.stdout).toContain("dg-daemon already current (v1.12.0).");
		expect(run.stdout).not.toContain("dg-skills already current");
	});

	test("the release workflow publishes SHA256SUMS and both bootstraps honor it", () => {
		const workflow = readRepoFile(".github", "workflows", "skills-release.yml");
		const sh = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		expect(workflow).toContain("sha256sum");
		expect(workflow).toContain("SHA256SUMS");
		expect(sh).toContain("SHA256SUMS");
		expect(sh).toContain("dg-skills verified");
		expect(ps1).toContain("SHA256SUMS");
		expect(ps1).toContain("dg-skills verified");
	});
});

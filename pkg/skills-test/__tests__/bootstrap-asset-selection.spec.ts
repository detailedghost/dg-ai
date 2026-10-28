import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
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
  case "$a" in http*) url="$a" ;; esac
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
*/archive/refs/tags/*)
  archtag=$(printf '%s' "$url" | sed -E 's#.*/archive/refs/tags/([^/]+)\\.tar\\.gz$#\\1#')
  if [ -n "$outfile" ]; then
    printf '%s\\t%s\\n' "$outfile" "$url" >> "$STUBDIR/downloads.log"
  fi
  if [ -f "$STUBDIR/archive-$archtag.tar.gz" ]; then
    cat "$STUBDIR/archive-$archtag.tar.gz" > "\${outfile:-/dev/stdout}"
  else
    echo "stub has no fixture archive for $archtag" >&2
    exit 1
  fi
  ;;
*)
  if [ -n "$outfile" ]; then
    printf '%s\\t%s\\n' "$outfile" "$url" >> "$STUBDIR/downloads.log"
  fi
  if [ -n "\${INSTALL_BODY:-}" ]; then
    printf '%s\\n' "$INSTALL_BODY" > "\${outfile:-/dev/stdout}"
  else
    printf '#!/bin/sh\\n# %s\\nexit 0\\n' "$url" > "\${outfile:-/dev/stdout}"
  fi
  ;;
esac
`;

type BootstrapRun = {
	dir: string;
	code: number;
	stdout: string;
	stderr: string;
	destUrl: string | undefined;
	versionContent: string | undefined;
	pageRequests: number;
	destPath: string;
	downloads: { out: string; url: string }[];
};

function fakeBinary(url: string): string {
	return `#!/bin/sh\n# ${url}\nexit 0\n`;
}

function archiveRoot(tag: string): string {
	return `dg-ai-${tag.replace(/^v/, "")}`;
}

/** Builds a real .tar.gz fixture in GitHub's layout so bootstrap.sh's own `tar -xzf` can extract it. */
function buildSourceArchive(stubDir: string, tag: string, skillName: string, skillBody: string): void {
	const srcRoot = join(stubDir, `source-${tag}`);
	const skillDir = join(srcRoot, archiveRoot(tag), "plugins", "dg", "skills", skillName);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), skillBody);
	const result = Bun.spawnSync(["tar", "-czf", join(stubDir, `archive-${tag}.tar.gz`), "-C", srcRoot, archiveRoot(tag)]);
	if (result.exitCode !== 0) {
		throw new Error(`failed to build fixture archive for ${tag}: ${result.stderr.toString()}`);
	}
}

async function runBootstrap(
	pages: Record<string, unknown>[][],
	options: {
		sums?: string;
		installBody?: string;
		dgHome?: string;
		skillsOnly?: boolean;
		args?: string[];
		env?: Record<string, string>;
		sourceArchives?: { tag: string; skillName: string; skillBody: string }[];
		outsideCheckout?: boolean;
		piped?: boolean;
	} = {},
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
	for (const { tag, skillName, skillBody } of options.sourceArchives ?? []) {
		buildSourceArchive(dir, tag, skillName, skillBody);
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
	let script = BOOTSTRAP;
	if (options.outsideCheckout) {
		script = join(dir, "remote", "nested", "bootstrap.sh");
		mkdirSync(join(dir, "remote", "nested"), { recursive: true });
		writeFileSync(script, readFileSync(BOOTSTRAP));
	}
	const proc = Bun.spawn(
		[
			options.piped ? "bash" : "sh",
			...(options.piped ? ["-s", "--"] : [script]),
			...(options.skillsOnly ? ["--skills-only"] : []),
			...(options.args ?? []),
		],
		{
			stdin: options.piped ? "pipe" : undefined,
			cwd: options.outsideCheckout ? dir : undefined,
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				HOME: home,
				DG_HOME: options.dgHome ?? "",
				STUBDIR: dir,
				DG_SKILLS_SOURCE: options.outsideCheckout ? "" : skillsSource,
				DG_SKILLS_DEST: join(dir, "skills-out"),
				COUNTER: counterFile,
				...(options.installBody ? { INSTALL_BODY: options.installBody } : {}),
				...(options.env ?? {}),
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (options.piped && proc.stdin) {
		proc.stdin.write(readFileSync(script));
		proc.stdin.end();
	}
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	const binRoot = join(options.dgHome || join(home, ".dg"), "bin");
	const destPath = join(binRoot, "dg-skills");
	const versionPath = join(binRoot, ".dg-skills.version");
	const destContent = existsSync(destPath)
		? readFileSync(destPath, "utf8")
		: undefined;
	const downloadsLog = join(dir, "downloads.log");
	const downloads = existsSync(downloadsLog)
		? readFileSync(downloadsLog, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const [out, url] = line.split("\t");
					return { out: out ?? "", url: url ?? "" };
				})
		: [];

	return {
		dir,
		code,
		stdout,
		stderr,
		destUrl: destContent?.split("\n")[1]?.replace(/^#\s*/, ""),
		versionContent: existsSync(versionPath)
			? readFileSync(versionPath, "utf8").trim()
			: undefined,
		pageRequests: Number(readFileSync(counterFile, "utf8").trim()),
		destPath,
		downloads,
	};
}

const SKILLS_ASSET = "dg-skills-linux-x64";

describe("bootstrap.sh picks its binary from the newest vX.Y.Z release", () => {
	test("resolves the asset from a vX.Y.Z release", async () => {
		const run = await runBootstrap([
			[release("v1.0.0", [SKILLS_ASSET, "dg-skills-macos-arm64"])],
		]);
		expect(run.code).toBe(0);
		expect(run.destUrl).toContain("/v1.0.0/");
		expect(run.destUrl?.endsWith(`/${SKILLS_ASSET}`)).toBe(true);
		expect(run.versionContent).toBe("1.0.0");
	});

	test("installs into $DG_HOME/bin when DG_HOME is set", async () => {
		const dgHome = mkdtempSync(join(tmpdir(), "dg-home-"));
		const run = await runBootstrap(
			[[release("v1.0.0", [SKILLS_ASSET])]],
			{ dgHome },
		);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain(`dg-skills installed at ${join(dgHome, "bin", "dg-skills")}`);
		expect(run.versionContent).toBe("1.0.0");
	});

	test("--skills-only installs the verified CLI from the vX.Y.Z release and never runs dg-skills install", async () => {
		const binary = '#!/bin/sh\necho "install ran: $*"\n';
		const sums = `${createHash("sha256").update(binary).digest("hex")}  ${SKILLS_ASSET}\n`;
		const run = await runBootstrap(
			[[release("daemon-v9.0.0", [SKILLS_ASSET]), release("v2.0.0", [SKILLS_ASSET, "SHA256SUMS"])]],
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
			[[release("v2.0.0", [SKILLS_ASSET, "SHA256SUMS"])]],
			{ sums: `${"0".repeat(64)}  ${SKILLS_ASSET}\n`, skillsOnly: true },
		);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain(`checksum mismatch for ${SKILLS_ASSET}`);
		expect(run.destUrl).toBeUndefined();
	});

	test("never selects a prefixed tag without a pin, and prefers v1.22.0 over v1.2.0 by semver", async () => {
		const run = await runBootstrap([
			[
				release("v1.23.0", [SKILLS_ASSET], true),
				release("skills-v1.21.1", [SKILLS_ASSET]),
				release("ext-v1.21.1", [SKILLS_ASSET]),
				release("v1.2.0", [SKILLS_ASSET]),
				release("v1.22.0", [SKILLS_ASSET]),
			],
		]);
		expect(run.code, run.stderr).toBe(0);
		expect(run.destUrl).toContain("/v1.22.0/");
		expect(run.versionContent).toBe("1.22.0");
	});

	test("resolves only a skills-v tag and fails when no vX.Y.Z release exists", async () => {
		const run = await runBootstrap([[release("skills-v1.21.1", [SKILLS_ASSET])]]);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("no vX.Y.Z release found");
		expect(run.destUrl).toBeUndefined();
	});

	test("takes the newest published vX.Y.Z tag, since unauthenticated callers never see drafts", async () => {
		const run = await runBootstrap([
			[
				release("v2.0.0", [SKILLS_ASSET]),
				release("v1.0.0", [SKILLS_ASSET]),
			],
		]);
		expect(run.destUrl).toContain("/v2.0.0/");
	});

	test("bootstrap.ps1 selects only vX.Y.Z tags unless a pin at or below 1.21.1 asks for skills-v", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1")
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("\n");
		expect(ps1).toContain("^v\\d+\\.\\d+\\.\\d+$");
		expect(ps1).not.toContain('$_.tag_name -like "skills-v*"');
		expect(ps1).toContain("Test-DgPrefixedVersion");
		expect(ps1).toContain('[version]"1.21.1"');
		expect(ps1).toContain("-replace '^(skills-)?v', ''");
	});

	test("the sibling installers filter drafts explicitly, since they can run authenticated", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		const lib = readRepoFile("pkg", "skills-cli", "src", "utils", "lib.ts");
		expect(ps1).toMatch(/-not\s+\$_\.draft/);
		expect(lib).toMatch(/!r\.draft/);
	});

	test("resolves nothing when only per-part prefixed releases carry the asset name", async () => {
		const run = await runBootstrap([[release("ext-v1.0.0", [SKILLS_ASSET])]]);
		expect(run.code).not.toBe(0);
		expect(run.destUrl).toBeUndefined();
	});

	test("does not match an asset whose name merely ends with the wanted one", async () => {
		const run = await runBootstrap([
			[release("v1.0.0", [`evil-${SKILLS_ASSET}`])],
		]);
		expect(run.code).not.toBe(0);
		expect(run.destUrl).toBeUndefined();
	});

	test("picks the newest vX.Y.Z release when several are published", async () => {
		const run = await runBootstrap([
			[
				release("v3.1.0", [SKILLS_ASSET]),
				release("v1.0.0", [SKILLS_ASSET]),
			],
		]);
		expect(run.destUrl).toContain("/v3.1.0/");
	});
});

describe("bootstrap.sh pins a version with --version or DG_VERSION", () => {
	const THREE_RELEASES = [
		release("v3.0.0", [SKILLS_ASSET]),
		release("v2.0.0", [SKILLS_ASSET]),
		release("v1.0.0", [SKILLS_ASSET]),
	];
	const ECHO_INSTALL = '#!/bin/sh\necho "install ran: $*"';

	test("--version normalizes and carries through to the dg-skills install call", async () => {
		const run = await runBootstrap([THREE_RELEASES], { args: ["--version", "2.0.0"], installBody: ECHO_INSTALL });
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("install ran: install --version 2.0.0");
	});

	test("--version=x.y.z works too", async () => {
		const run = await runBootstrap([THREE_RELEASES], { args: ["--version=2.0.0"], installBody: ECHO_INSTALL });
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("install ran: install --version 2.0.0");
	});

	test("DG_VERSION picks the same tag as --version", async () => {
		const run = await runBootstrap([THREE_RELEASES], { env: { DG_VERSION: "2.0.0" }, installBody: ECHO_INSTALL });
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("install ran: install --version 2.0.0");
	});

	test("accepts a leading v or a full skills-v prefix", async () => {
		const withV = await runBootstrap([THREE_RELEASES], {
			args: ["--version", "v2.0.0"],
			installBody: ECHO_INSTALL,
		});
		const withSkillsV = await runBootstrap([THREE_RELEASES], {
			args: ["--version", "v2.0.0"],
			installBody: ECHO_INSTALL,
		});
		expect(withV.stdout).toContain("install ran: install --version 2.0.0");
		expect(withSkillsV.stdout).toContain("install ran: install --version 2.0.0");
	});

	test("--version takes priority over DG_VERSION", async () => {
		const run = await runBootstrap([THREE_RELEASES], {
			args: ["--version", "2.0.0"],
			env: { DG_VERSION: "1.0.0" },
			installBody: ECHO_INSTALL,
		});
		expect(run.stdout).toContain("install ran: install --version 2.0.0");
	});

	test("--version with no value fails before any download", async () => {
		const run = await runBootstrap([THREE_RELEASES], { args: ["--version"] });
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("--version requires a value");
		expect(run.pageRequests).toBe(0);
	});

	test("downloads the newest release to a temp installer, never the pinned one, and removes it afterward", async () => {
		const run = await runBootstrap([THREE_RELEASES], { args: ["--version", "2.0.0"], installBody: ECHO_INSTALL });
		expect(run.code, run.stderr).toBe(0);
		expect(run.destUrl).toBeUndefined();
		expect(run.versionContent).toBeUndefined();
		expect(run.downloads).toHaveLength(1);
		expect(run.downloads[0]?.url).toContain("/v3.0.0/");
		expect(run.downloads[0]?.out).not.toBe(run.destPath);
		expect(existsSync(run.downloads[0]?.out ?? "")).toBe(false);
	});

	test("a pin matching no release still delegates, leaving validation to the newest binary's own install", async () => {
		const run = await runBootstrap([THREE_RELEASES], { args: ["--version", "9.9.9"], installBody: ECHO_INSTALL });
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("install ran: install --version 9.9.9");
		expect(run.downloads[0]?.url).toContain("/v3.0.0/");
	});

	test("--skills-only still pins the exact release directly and fails clearly when it is missing", async () => {
		const run = await runBootstrap([THREE_RELEASES], { args: ["--version", "9.9.9"], skillsOnly: true });
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("no release named v9.9.9 found");
		expect(run.destUrl).toBeUndefined();
	});

	test("--skills-only pins v1.22.0 to the vX.Y.Z tag", async () => {
		const run = await runBootstrap(
			[[release("v1.22.0", [SKILLS_ASSET]), release("skills-v1.21.1", [SKILLS_ASSET])]],
			{ args: ["--version", "1.22.0"], skillsOnly: true },
		);
		expect(run.code, run.stderr).toBe(0);
		expect(run.destUrl).toContain("/v1.22.0/");
		expect(run.versionContent).toBe("1.22.0");
	});

	test("--skills-only resolves a pin at or below 1.21.1 to the old skills-v tag", async () => {
		const releases = [
			release("v1.22.0", [SKILLS_ASSET]),
			release("skills-v1.21.1", [SKILLS_ASSET]),
			release("skills-v1.21.0", [SKILLS_ASSET]),
		];
		for (const pin of ["1.21.1", "1.21.0"]) {
			const run = await runBootstrap([releases], { args: ["--version", pin], skillsOnly: true });
			expect(run.code, run.stderr).toBe(0);
			expect(run.destUrl).toContain(`/skills-v${pin}/`);
			expect(run.versionContent).toBe(pin);
		}
	});

	test("a pin carries through alongside --cli-only, delegated through the newest binary", async () => {
		const run = await runBootstrap([THREE_RELEASES], {
			args: ["--cli-only", "--version", "2.0.0"],
			installBody: ECHO_INSTALL,
		});
		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain("install ran: install --cli-only --version 2.0.0");
		expect(run.destUrl).toBeUndefined();
	});

	test("fails before any temp installer when the newest release has no asset for this platform", async () => {
		const run = await runBootstrap(
			[[release("v3.0.0", []), release("v2.0.0", [SKILLS_ASSET])]],
			{ args: ["--version", "2.0.0"] },
		);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain(`no ${SKILLS_ASSET} asset in v3.0.0`);
		expect(run.downloads).toHaveLength(0);
	});
});

describe("bootstrap.sh pages past the first release listing", () => {
	test("scans a second page when no vX.Y.Z release appears on the first", async () => {
		const run = await runBootstrap([
			filler(100),
			[release("v1.2.3", [SKILLS_ASSET])],
		]);
		expect(run.pageRequests).toBe(2);
		expect(run.destUrl).toContain("/v1.2.3/");
		expect(run.versionContent).toBe("1.2.3");
	});

	test("picks the highest vX.Y.Z across pages, not the first page that has one", async () => {
		const run = await runBootstrap([
			[...filler(99), release("v1.2.3", [SKILLS_ASSET])],
			[release("v1.10.0", [SKILLS_ASSET])],
		]);
		expect(run.pageRequests).toBe(2);
		expect(run.destUrl).toContain("/v1.10.0/");
	});

	test("bootstrap.ps1 keeps scanning pages until it can pick the highest unpinned version", () => {
		const ps1 = readFileSync(new URL("../../skills-cli/bootstrap.ps1", import.meta.url), "utf8");
		expect(ps1).not.toMatch(/if \(\$script:rel -or \$batch\.Count -lt \$perPage\)/);
	});

	test("stops at the page cap instead of scanning forever when no vX.Y.Z release exists", async () => {
		const run = await runBootstrap(
			Array.from({ length: 12 }, () => filler(100)),
		);
		expect(run.pageRequests).toBe(10);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("1000 releases scanned");
	});
});

describe("bootstrap.sh checksums and the fresh-install message", () => {
	const tag = "v1.0.0";
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
		const run = await runBootstrap([[release("v1.12.0", [SKILLS_ASSET])]], {
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

	test("gives the installer no stdin when the script is piped into bash", async () => {
		const run = await runBootstrap([[release("v1.12.0", [SKILLS_ASSET])]], {
			piped: true,
			args: ["--cli-only"],
			installBody: [
				"#!/bin/sh",
				`[ "$(head -c 1 | wc -c)" -eq 0 ] || { echo 'installer read stdin' >&2; exit 9; }`,
				"printf '%s\\n' 'dg-skills already current (v1.12.0).'",
				"exit 0",
			].join("\n"),
		});
		expect(run.code, run.stderr).toBe(0);
		expect(run.stderr).not.toContain("installer read stdin");
		expect(run.stdout).toContain("dg-skills verified (v1.12.0).");
	});

	test("the release workflow publishes SHA256SUMS and both bootstraps honor it", () => {
		const workflow = readRepoFile(".github", "workflows", "release.yml");
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

describe("bootstrap.sh reads the root directory GitHub puts in a source archive", () => {
	test("--skills-only removes the retired phone-friend skill and keeps unrelated folders", async () => {
		const dest = mkdtempSync(join(tmpdir(), "dg-bootstrap-dest-"));
		mkdirSync(join(dest, "phone-friend"), { recursive: true });
		writeFileSync(join(dest, "phone-friend", "SKILL.md"), "old stub\n");
		mkdirSync(join(dest, "my-own-skill"), { recursive: true });
		writeFileSync(join(dest, "my-own-skill", "SKILL.md"), "mine\n");
		const run = await runBootstrap([[release("v1.22.0", [SKILLS_ASSET])]], {
			skillsOnly: true,
			env: { DG_SKILLS_DEST: dest },
		});
		expect(run.code, run.stderr).toBe(0);
		expect(existsSync(join(dest, "phone-friend"))).toBe(false);
		expect(readFileSync(join(dest, "my-own-skill", "SKILL.md"), "utf8")).toBe("mine\n");
		expect(readFileSync(join(dest, "probe", "SKILL.md"), "utf8")).toBe("probe\n");
		rmSync(dest, { recursive: true, force: true });
	});

	test("--skills-only finds the skills in dg-ai-1.22.0, the root GitHub gives the v1.22.0 tag", async () => {
		const run = await runBootstrap([[release("v1.22.0", [SKILLS_ASSET])]], {
			skillsOnly: true,
			outsideCheckout: true,
			sourceArchives: [{ tag: "v1.22.0", skillName: "probe", skillBody: "new scheme probe\n" }],
		});
		expect(run.code, run.stderr).toBe(0);
		expect(readFileSync(join(run.dir, "skills-out", "probe", "SKILL.md"), "utf8")).toBe("new scheme probe\n");
	});

	test("--skills-only finds the skills in dg-ai-skills-v1.21.1, the root GitHub gives a prefixed tag", async () => {
		const run = await runBootstrap(
			[[release("v1.22.0", [SKILLS_ASSET]), release("skills-v1.21.1", [SKILLS_ASSET])]],
			{
				args: ["--version", "1.21.1"],
				skillsOnly: true,
				outsideCheckout: true,
				sourceArchives: [{ tag: "skills-v1.21.1", skillName: "probe", skillBody: "legacy probe\n" }],
			},
		);
		expect(run.code, run.stderr).toBe(0);
		expect(readFileSync(join(run.dir, "skills-out", "probe", "SKILL.md"), "utf8")).toBe("legacy probe\n");
	});

	test("the Codex install finds the skills in dg-ai-1.22.0 for an unpinned run", async () => {
		const codexHome = mkdtempSync(join(tmpdir(), "dg-codex-home-"));
		try {
			const run = await runBootstrap([[release("v1.22.0", [SKILLS_ASSET])]], {
				installBody: '#!/bin/sh\necho "install ran: $*"',
				env: { DG_INSTALL_CODEX: "1", CODEX_HOME: codexHome },
				sourceArchives: [{ tag: "v1.22.0", skillName: "probe", skillBody: "new scheme probe\n" }],
			});
			expect(run.code, run.stderr).toBe(0);
			expect(readFileSync(join(codexHome, "skills", "probe", "SKILL.md"), "utf8")).toBe("new scheme probe\n");
		} finally {
			rmSync(codexHome, { recursive: true, force: true });
		}
	});

	test("bootstrap.ps1 finds the one extracted root instead of building dg-ai-<tag>", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		const fn = ps1.slice(ps1.indexOf("function Expand-DgSourceArchive"), ps1.indexOf("function Get-DgSkillsSource"));
		expect(fn).toContain("Expand-Archive");
		expect(fn).toContain("Get-ChildItem -LiteralPath $Destination -Directory");
		expect(fn).toContain("$roots.Count -ne 1");
		expect(ps1).not.toContain('"dg-ai-$tag');
		expect(ps1).not.toContain('"dg-ai-$codexTag');
		expect(ps1.match(/Expand-DgSourceArchive -Archive/g)).toHaveLength(2);
	});
});

describe("bootstrap.sh DG_INSTALL_CODEX uses the pinned tag, not the newest", () => {
	const TWO_RELEASES = [
		release("v3.0.0", [SKILLS_ASSET]),
		release("v2.0.0", [SKILLS_ASSET]),
	];

	test("a pinned install's Codex archive and extraction dir come from the pinned tag", async () => {
		const codexHome = mkdtempSync(join(tmpdir(), "dg-codex-home-"));
		try {
			const run = await runBootstrap([TWO_RELEASES], {
				args: ["--version", "2.0.0"],
				installBody: '#!/bin/sh\necho "install ran: $*"',
				env: { DG_INSTALL_CODEX: "1", CODEX_HOME: codexHome },
				sourceArchives: [
					{ tag: "v3.0.0", skillName: "probe", skillBody: "newest probe\n" },
					{ tag: "v2.0.0", skillName: "probe", skillBody: "pinned probe\n" },
				],
			});
			expect(run.code, run.stderr).toBe(0);
			expect(run.downloads.some((d) => d.url.includes("/archive/refs/tags/v2.0.0.tar.gz"))).toBe(true);
			expect(run.downloads.some((d) => d.url.includes("/archive/refs/tags/v3.0.0.tar.gz"))).toBe(false);
			expect(readFileSync(join(codexHome, "skills", "probe", "SKILL.md"), "utf8")).toBe("pinned probe\n");
		} finally {
			rmSync(codexHome, { recursive: true, force: true });
		}
	});
});

describe("bootstrap.sh DG_INSTALL_CODEX with a pin at or below 1.21.1", () => {
	test("the Codex archive comes from the old skills-v tag", async () => {
		const codexHome = mkdtempSync(join(tmpdir(), "dg-codex-home-"));
		try {
			const run = await runBootstrap(
				[[release("v1.22.0", [SKILLS_ASSET]), release("skills-v1.21.1", [SKILLS_ASSET])]],
				{
					args: ["--version", "1.21.1"],
					installBody: '#!/bin/sh\necho "install ran: $*"',
					env: { DG_INSTALL_CODEX: "1", CODEX_HOME: codexHome },
					sourceArchives: [
						{ tag: "v1.22.0", skillName: "probe", skillBody: "newest probe\n" },
						{ tag: "skills-v1.21.1", skillName: "probe", skillBody: "legacy probe\n" },
					],
				},
			);
			expect(run.code, run.stderr).toBe(0);
			expect(run.downloads.some((d) => d.url.includes("/archive/refs/tags/skills-v1.21.1.tar.gz"))).toBe(true);
			expect(readFileSync(join(codexHome, "skills", "probe", "SKILL.md"), "utf8")).toBe("legacy probe\n");
		} finally {
			rmSync(codexHome, { recursive: true, force: true });
		}
	});
});

describe("bootstrap.ps1 DG_INSTALL_CODEX uses the pinned tag, not the newest", () => {
	test("the Codex archive URL and extraction path use a pin-aware tag, not $rel.tag_name directly", () => {
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		const codexBlock = ps1.slice(ps1.indexOf("DG_INSTALL_CODEX"));
		expect(codexBlock).toContain(
			'$codexTag = if (-not $script:pinnedVersion) { $rel.tag_name } elseif (Test-DgPrefixedVersion $script:pinnedVersion) { "skills-v$($script:pinnedVersion)" } else { "v$($script:pinnedVersion)" }',
		);
		expect(codexBlock).toContain("archive/refs/tags/$codexTag.zip");
		expect(codexBlock).toContain('Join-Path $sourceRoot "plugins\\dg\\skills"');
	});
});

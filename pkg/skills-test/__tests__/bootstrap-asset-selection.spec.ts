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
*)
  printf '#!/bin/sh\\n# %s\\nexit 0\\n' "$url" > "\${outfile:-/dev/stdout}"
  ;;
esac
`;

type BootstrapRun = {
	code: number;
	stderr: string;
	destUrl: string | undefined;
	versionContent: string | undefined;
	pageRequests: number;
};

async function runBootstrap(
	pages: Record<string, unknown>[][],
): Promise<BootstrapRun> {
	const dir = mkdtempSync(join(tmpdir(), "dg-bootstrap-test-"));
	const binDir = join(dir, "stubbin");
	mkdirSync(binDir, { recursive: true });
	pages.forEach((pageReleases, i) => {
		writeFileSync(join(dir, `page${i + 1}.json`), JSON.stringify(pageReleases));
	});
	const counterFile = join(dir, "counter");
	writeFileSync(counterFile, "0");
	writeFileSync(join(binDir, "curl"), CURL_STUB);
	chmodSync(join(binDir, "curl"), 0o755);

	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });

	const proc = Bun.spawn(["sh", BOOTSTRAP], {
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
			HOME: home,
			STUBDIR: dir,
			COUNTER: counterFile,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	const destPath = join(home, ".dg", "bin", "dg-skills");
	const versionPath = join(home, ".dg", "bin", ".dg-skills.version");
	const destContent = existsSync(destPath)
		? readFileSync(destPath, "utf8")
		: undefined;

	return {
		code,
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

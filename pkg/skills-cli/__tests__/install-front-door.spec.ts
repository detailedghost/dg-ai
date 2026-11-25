import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { finishLauncherLayout } from "../src/install/layout";
import { installCompiled, versionProgramPath, writeDgLink } from "../src/install/compiled";
import { readCurrent } from "../src/install/current";
import { patchAssetName } from "../src/install/patch";
import { frontDoorAssetName, frontDoorRid, frontEnabled, installLayout } from "../src/install/front-door";
import { cliLauncher } from "../src/doctor/probes";
import { runUpdate, type UpdateDeps } from "../src/update/run";
import { compiledAssetName, type PickedProgram, platformKey } from "../src/utils/lib";
import { fenceEnv } from "./fence-env";
import { ownedCommand } from "../src/hooks/settings/marker";
import { settingsWorld } from "./hooks-settings/settings-fixtures";
import { present, programRun, removeBootstrapDirs, runBootstrap, sha256 as hashOf } from "./bootstrap-fixtures";
import { RELEASE_BASE, type Scratch, scratch, sha256, stubFetch } from "./release-fixtures";

const POSIX = process.platform !== "win32";
const CAN_PATCH = POSIX && Bun.which("zstd") !== null;

let box: Scratch | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
	restore?.();
	restore = undefined;
	box?.cleanup();
	box = undefined;
	removeBootstrapDirs();
});

const KEY = platformKey();
const BUN_ASSET = compiledAssetName(KEY);
const FRONT_ASSET = frontDoorAssetName(KEY);

const bunBody = (version: string, marker?: string): string =>
	`#!/bin/sh\nif [ "$1" = "--version" ]; then ${marker ? `echo ran >> '${marker}'; ` : ""}echo "${version}"; exit 0; fi\necho "BUN ${version} $*"\n# ${"bun payload ".repeat(400)}${version}\n`;

const frontBody = (version: string, opts: { exit?: number; marker?: string; printed?: string } = {}): string =>
	`#!/bin/sh\nif [ "$1" = "--version" ]; then ${opts.marker ? `echo ran >> '${opts.marker}'; ` : ""}echo "${opts.printed ?? version}"; exit ${opts.exit ?? 0}; fi\necho "FRONT ${version} $*"\n# ${"front payload ".repeat(400)}${version}\n`;

type Served = {
	bun?: string;
	front?: string | null;
	frontSums?: "match" | "wrong" | "missing";
	frontEncoding?: "raw" | "zst" | "gz";
	frontUnserved?: boolean;
	key?: string;
	patches?: Record<string, string | Uint8Array>;
};

function serve(version: string, served: Served = {}) {
	const bunAsset = served.key ? compiledAssetName(served.key) : BUN_ASSET;
	const frontAsset = served.key ? frontDoorAssetName(served.key) : FRONT_ASSET;
	const base = `${RELEASE_BASE}/v${version}`;
	const bun = served.bun ?? bunBody(version);
	const front = served.front === undefined ? frontBody(version) : served.front;
	const routes: Record<string, string | Uint8Array> = { [`${base}/${bunAsset}`]: bun };
	const lines = [`${sha256(bun)}  ${bunAsset}`];
	if (front !== null) {
		const encoding = served.frontEncoding ?? "raw";
		const sum = served.frontSums === "wrong" ? sha256("something else") : sha256(front);
		if (served.frontSums !== "missing") lines.push(`${sum}  ${frontAsset}`);
		if (encoding === "zst") {
			const packed = Bun.zstdCompressSync(front);
			routes[`${base}/${frontAsset}.zst`] = packed;
			lines.push(`${sha256(packed)}  ${frontAsset}.zst`);
		} else if (encoding === "gz") {
			const packed = Bun.gzipSync(front);
			routes[`${base}/${frontAsset}.gz`] = packed;
			lines.push(`${sha256(packed)}  ${frontAsset}.gz`);
		} else if (!served.frontUnserved) {
			routes[`${base}/${frontAsset}`] = front;
		}
	}
	for (const [name, body] of Object.entries(served.patches ?? {})) routes[`${base}/${name}`] = body;
	routes[`${base}/SHA256SUMS`] = `${lines.join("\n")}\n`;
	const stub = stubFetch(routes);
	restore = stub.restore;
	const picked: PickedProgram = { version, assetName: bunAsset, url: `${base}/${bunAsset}`, sumsUrl: `${base}/SHA256SUMS` };
	return { picked, calls: stub.calls };
}

function hermeticEnv(tree: Scratch, extra: Record<string, string> = {}): Record<string, string> {
	return { ...fenceEnv(), DG_HOME: join(tree.directory, "dg-home"), ...extra };
}

function stderrOf(body: () => Promise<unknown>): Promise<string[]> {
	const lines: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		lines.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return body()
		.then(() => lines.join("").split("\n").filter(Boolean))
		.finally(() => {
			process.stderr.write = original;
		});
}

const read = (path: string): string => readFileSync(path, "utf8");
const versionFiles = (root: string, version: string): string[] => readdirSync(join(root, "bin", version)).sort();
const installedVersions = (root: string): string[] => readdirSync(join(root, "bin")).filter((name) => /^\d/.test(name)).sort();

describe("front door asset names", () => {
	test("the eight Bun platform keys map onto the six front door RIDs", () => {
		expect(
			Object.fromEntries(
				["linux-x64", "linux-x64-baseline", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-x64-baseline", "windows-arm64"].map((key) => [key, frontDoorRid(key)]),
			),
		).toEqual({
			"linux-x64": "linux-x64",
			"linux-x64-baseline": "linux-x64",
			"linux-arm64": "linux-arm64",
			"darwin-x64": "osx-x64",
			"darwin-arm64": "osx-arm64",
			"windows-x64": "win-x64",
			"windows-x64-baseline": "win-x64",
			"windows-arm64": "win-arm64",
		});
	});

	test("the asset is dg-front-<rid>, with .exe on Windows", () => {
		expect(frontDoorAssetName("linux-x64-baseline")).toBe("dg-front-linux-x64");
		expect(frontDoorAssetName("darwin-arm64")).toBe("dg-front-osx-arm64");
		expect(frontDoorAssetName("windows-x64-baseline")).toBe("dg-front-win-x64.exe");
		expect(frontDoorAssetName("windows-arm64")).toBe("dg-front-win-arm64.exe");
	});
});

describe("installLayout", () => {
	const root = "/data/dg";

	test("defaults to the front door at dg and the Bun binary at dg-core", () => {
		expect(installLayout({ root, version: "7.1.0", platform: "linux" })).toEqual({
			dg: "/data/dg/bin/7.1.0/dg",
			dgCore: "/data/dg/bin/7.1.0/dg-core",
		});
	});

	test("with the front door off, dg is the Bun binary and dg-core names the same file", () => {
		expect(installLayout({ root, version: "7.1.0", platform: "linux", front: false })).toEqual({
			dg: "/data/dg/bin/7.1.0/dg",
			dgCore: "/data/dg/bin/7.1.0/dg",
		});
	});

	test("Windows names both files with .exe", () => {
		const layout = installLayout({ root: "C:\\dg", version: "7.1.0", platform: "win32" });
		expect(layout.dg.endsWith("dg.exe")).toBe(true);
		expect(layout.dgCore.endsWith("dg-core.exe")).toBe(true);
	});
});

describe("frontEnabled", () => {
	test("is on with no DG_FRONT and no config key", () => {
		box = scratch("front-default");
		expect(frontEnabled(hermeticEnv(box))).toBe(true);
	});

	test("DG_FRONT=0 turns it off", () => {
		box = scratch("front-env");
		expect(frontEnabled(hermeticEnv(box, { DG_FRONT: "0" }))).toBe(false);
	});

	test("front.enabled = false in config.toml turns it off", () => {
		box = scratch("front-toml");
		const env = hermeticEnv(box);
		mkdirSync(join(env.DG_HOME as string, "config"), { recursive: true });
		writeFileSync(join(env.DG_HOME as string, "config", "config.toml"), "[front]\nenabled = false\n");
		expect(frontEnabled(env)).toBe(false);
	});

	test("DG_FRONT=1 wins over front.enabled = false", () => {
		box = scratch("front-env-wins");
		const env = hermeticEnv(box, { DG_FRONT: "1" });
		mkdirSync(join(env.DG_HOME as string, "config"), { recursive: true });
		writeFileSync(join(env.DG_HOME as string, "config", "config.toml"), "[front]\nenabled = false\n");
		expect(frontEnabled(env)).toBe(true);
	});

	test("a config.toml that does not parse keeps the Bun-only layout", () => {
		box = scratch("front-bad-toml");
		const env = hermeticEnv(box);
		mkdirSync(join(env.DG_HOME as string, "config"), { recursive: true });
		writeFileSync(join(env.DG_HOME as string, "config", "config.toml"), "[front\nenabled = ");
		expect(frontEnabled(env)).toBe(false);
	});
});

describe.skipIf(!POSIX)("a default install", () => {
	test("places the front door at dg and the Bun binary at dg-core", async () => {
		box = scratch("front-default-install");
		const { picked } = serve("7.0.0");
		const dg = await installCompiled(box.root, picked, "linux", { env: hermeticEnv(box) });
		const layout = installLayout({ root: box.root, version: "7.0.0", platform: "linux" });

		expect(dg).toBe(layout.dg);
		expect(read(layout.dg)).toBe(frontBody("7.0.0"));
		expect(read(layout.dgCore)).toBe(bunBody("7.0.0"));
		expect(statSync(layout.dg).mode & 0o777).toBe(0o755);
		expect(statSync(layout.dgCore).mode & 0o777).toBe(0o755);
		expect(versionFiles(box.root, "7.0.0")).toEqual(["dg", "dg-core"]);
		expect(readCurrent(box.root, "bin")).toBe("7.0.0");
	});

	test("reads the front door from the .zst asset when the release lists one", async () => {
		box = scratch("front-zst");
		const { picked, calls } = serve("7.0.0", { frontEncoding: "zst" });
		await installCompiled(box.root, picked, "linux", { env: hermeticEnv(box) });

		expect(read(installLayout({ root: box.root, version: "7.0.0", platform: "linux" }).dg)).toBe(frontBody("7.0.0"));
		expect(calls).toContain(`${RELEASE_BASE}/v7.0.0/${FRONT_ASSET}.zst`);
		expect(calls).not.toContain(`${RELEASE_BASE}/v7.0.0/${FRONT_ASSET}`);
	});

	test("reads the front door from the .gz asset when there is no .zst", async () => {
		box = scratch("front-gz");
		const { picked, calls } = serve("7.0.0", { frontEncoding: "gz" });
		await installCompiled(box.root, picked, "linux", { env: hermeticEnv(box) });

		expect(read(installLayout({ root: box.root, version: "7.0.0", platform: "linux" }).dg)).toBe(frontBody("7.0.0"));
		expect(calls).toContain(`${RELEASE_BASE}/v7.0.0/${FRONT_ASSET}.gz`);
	});

	test("prints nothing about the front door when it installs", async () => {
		const tree = scratch("front-quiet");
		box = tree;
		const { picked } = serve("7.0.0");
		const lines = await stderrOf(() => installCompiled(tree.root, picked, "linux", { env: hermeticEnv(tree) }));
		expect(lines).toEqual([]);
	});
});

describe.skipIf(!POSIX)("the Windows file names", () => {
	for (const key of ["windows-x64", "windows-x64-baseline", "windows-arm64"]) {
		test(`${key} installs dg.exe and dg-core.exe from ${frontDoorAssetName(key)}`, async () => {
			box = scratch("front-win-names");
			const { picked, calls } = serve("7.0.0", { key });
			await installCompiled(box.root, picked, "win32", { env: hermeticEnv(box) });

			expect(readdirSync(join(box.root, "bin", "7.0.0")).sort()).toEqual(["dg-core.exe", "dg.exe"]);
			expect(calls).toContain(`${RELEASE_BASE}/v7.0.0/${frontDoorAssetName(key)}`);
		});
	}

	test("installing again with the opt-out leaves dg.exe alone and no set-aside file", async () => {
		box = scratch("front-win-uninstall");
		const { picked } = serve("7.0.0", { key: "windows-x64" });
		await installCompiled(box.root, picked, "win32", { env: hermeticEnv(box) });
		await installCompiled(box.root, picked, "win32", { env: hermeticEnv(box, { DG_FRONT: "0" }) });

		expect(readdirSync(join(box.root, "bin", "7.0.0"))).toEqual(["dg.exe"]);
		expect(read(join(box.root, "bin", "7.0.0", "dg.exe"))).toBe(bunBody("7.0.0"));
	});
});

describe.skipIf(!POSIX)("the opt-outs keep the Bun-only layout", () => {
	test("DG_FRONT=0 installs the Bun binary at dg, with no dg-core and no front door download", async () => {
		box = scratch("front-off-env");
		const { picked, calls } = serve("7.0.0");
		await installCompiled(box.root, picked, "linux", { env: hermeticEnv(box, { DG_FRONT: "0" }) });

		expect(versionFiles(box.root, "7.0.0")).toEqual(["dg"]);
		expect(read(versionProgramPath(box.root, "7.0.0", "linux"))).toBe(bunBody("7.0.0"));
		expect(calls.filter((url) => url.includes("dg-front-"))).toEqual([]);
	});

	test("front.enabled = false in config.toml installs the Bun binary at dg", async () => {
		box = scratch("front-off-toml");
		const env = hermeticEnv(box);
		mkdirSync(join(env.DG_HOME as string, "config"), { recursive: true });
		writeFileSync(join(env.DG_HOME as string, "config", "config.toml"), "[front]\nenabled = false\n");
		const { picked } = serve("7.0.0");
		await installCompiled(box.root, picked, "linux", { env });

		expect(versionFiles(box.root, "7.0.0")).toEqual(["dg"]);
		expect(read(versionProgramPath(box.root, "7.0.0", "linux"))).toBe(bunBody("7.0.0"));
	});

	test("an update under DG_FRONT=0 stays Bun-only", async () => {
		box = scratch("front-off-update");
		const env = hermeticEnv(box, { DG_FRONT: "0" });
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env });
		restore?.();
		await installCompiled(box.root, serve("7.1.0").picked, "linux", { env });

		expect(versionFiles(box.root, "7.1.0")).toEqual(["dg"]);
		expect(readCurrent(box.root, "bin")).toBe("7.1.0");
	});
});

describe.skipIf(!POSIX)("a front door that cannot be used leaves the Bun binary at dg", () => {
	const bunOnly = (tree: Scratch, version: string): void => {
		const layout = installLayout({ root: tree.root, version, platform: "linux", front: false });
		expect(versionFiles(tree.root, version)).toEqual(["dg"]);
		expect(read(layout.dg)).toBe(bunBody(version));
		expect(readCurrent(tree.root, "bin")).toBe(version);
		const probe = Bun.spawnSync([layout.dg, "--version"]);
		expect(probe.stdout.toString().trim()).toBe(version);
	};

	test("a front door that fails its --version check falls back, with one line", async () => {
		box = scratch("front-bad-version");
		const { picked } = serve("7.0.0", { front: frontBody("7.0.0", { exit: 3 }) });
		const lines = await stderrOf(() => installCompiled(box!.root, picked, "linux", { env: hermeticEnv(box!) }));

		bunOnly(box, "7.0.0");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("front door");
	});

	test("a front door that prints another version falls back", async () => {
		box = scratch("front-wrong-version");
		const { picked } = serve("7.0.0", { front: frontBody("7.0.0", { printed: "6.9.9" }) });
		const lines = await stderrOf(() => installCompiled(box!.root, picked, "linux", { env: hermeticEnv(box!) }));

		bunOnly(box, "7.0.0");
		expect(lines).toHaveLength(1);
	});

	test("a failed front door download falls back, with one line", async () => {
		box = scratch("front-download-fails");
		const { picked } = serve("7.0.0", { frontUnserved: true });
		const lines = await stderrOf(() => installCompiled(box!.root, picked, "linux", { env: hermeticEnv(box!) }));

		bunOnly(box, "7.0.0");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("front door");
	});

	test("a release with no front door asset falls back, with one line", async () => {
		box = scratch("front-missing-asset");
		const { picked } = serve("7.0.0", { front: null });
		const lines = await stderrOf(() => installCompiled(box!.root, picked, "linux", { env: hermeticEnv(box!) }));

		bunOnly(box, "7.0.0");
		expect(lines).toHaveLength(1);
	});

	test("a front door with no SHA256SUMS entry falls back and is never run", async () => {
		box = scratch("front-no-sum");
		const marker = join(box.directory, "ran");
		const { picked } = serve("7.0.0", { front: frontBody("7.0.0", { marker }), frontSums: "missing" });
		await stderrOf(() => installCompiled(box!.root, picked, "linux", { env: hermeticEnv(box!) }));

		bunOnly(box, "7.0.0");
		expect(existsSync(marker)).toBe(false);
	});

	test("a front door whose sha256 does not match falls back and is never run", async () => {
		box = scratch("front-bad-sum");
		const marker = join(box.directory, "ran");
		const { picked } = serve("7.0.0", { front: frontBody("7.0.0", { marker }), frontSums: "wrong" });
		const lines = await stderrOf(() => installCompiled(box!.root, picked, "linux", { env: hermeticEnv(box!) }));

		bunOnly(box, "7.0.0");
		expect(existsSync(marker)).toBe(false);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("checksum mismatch");
	});

	test("a Bun binary that fails its own check still fails the install, with no front door tried", async () => {
		box = scratch("front-bun-broken");
		const { picked, calls } = serve("7.0.0", { bun: "#!/bin/sh\nexit 3\n" });
		await expect(installCompiled(box.root, picked, "linux", { env: hermeticEnv(box) })).rejects.toThrow("dg self-check failed");

		expect(existsSync(join(box.root, "bin", "7.0.0"))).toBe(false);
		expect(calls.filter((url) => url.includes("dg-front-"))).toEqual([]);
	});
});

describe.skipIf(!POSIX)("update and rollback", () => {
	test("an update installs a new front door and a new Bun binary, and keeps the old version for rollback", async () => {
		box = scratch("front-update-both");
		const env = hermeticEnv(box);
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env });
		restore?.();
		await installCompiled(box.root, serve("7.1.0").picked, "linux", { env });
		const next = installLayout({ root: box.root, version: "7.1.0", platform: "linux" });

		expect(read(next.dg)).toBe(frontBody("7.1.0"));
		expect(read(next.dgCore)).toBe(bunBody("7.1.0"));
		expect(readCurrent(box.root, "bin")).toBe("7.1.0");
		expect(installedVersions(box.root)).toEqual(["7.0.0", "7.1.0"]);
	});

	test.skipIf(!CAN_PATCH)("delta patches update the front door from the old dg and the Bun binary from the old dg-core", async () => {
		box = scratch("front-update-patch");
		const env = hermeticEnv(box);
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env });
		restore?.();
		const patchOf = (oldBody: string, newBody: string): Uint8Array => {
			const [oldFile, newFile, patchFile] = ["old", "new", "patch"].map((name) => join(box!.directory, name));
			writeFileSync(oldFile, oldBody);
			writeFileSync(newFile, newBody);
			const run = Bun.spawnSync([Bun.which("zstd") as string, "-q", "-19", "--long=27", "--force", `--patch-from=${oldFile}`, newFile, "-o", patchFile]);
			if (run.exitCode !== 0) throw new Error(run.stderr.toString());
			return new Uint8Array(readFileSync(patchFile));
		};
		const { picked, calls } = serve("7.1.0", {
			patches: {
				[patchAssetName(BUN_ASSET, "7.0.0")]: patchOf(bunBody("7.0.0"), bunBody("7.1.0")),
				[patchAssetName(FRONT_ASSET, "7.0.0")]: patchOf(frontBody("7.0.0"), frontBody("7.1.0")),
			},
		});
		await installCompiled(box.root, picked, "linux", { env });
		const next = installLayout({ root: box.root, version: "7.1.0", platform: "linux" });

		expect(read(next.dg)).toBe(frontBody("7.1.0"));
		expect(read(next.dgCore)).toBe(bunBody("7.1.0"));
		expect(calls.some((url) => url.endsWith(`/${BUN_ASSET}`))).toBe(false);
		expect(calls.some((url) => url.endsWith(`/${FRONT_ASSET}`))).toBe(false);
	});

	test("a failed front door update leaves the new Bun-only layout working and the old version in place", async () => {
		box = scratch("front-update-fails");
		const env = hermeticEnv(box);
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env });
		restore?.();
		await stderrOf(() => installCompiled(box!.root, serve("7.1.0", { front: frontBody("7.1.0", { exit: 3 }) }).picked, "linux", { env }));
		const layout = installLayout({ root: box.root, version: "7.1.0", platform: "linux", front: false });

		expect(versionFiles(box.root, "7.1.0")).toEqual(["dg"]);
		expect(Bun.spawnSync([layout.dg, "--version"]).stdout.toString().trim()).toBe("7.1.0");
		expect(readCurrent(box.root, "bin")).toBe("7.1.0");
		expect(versionFiles(box.root, "7.0.0")).toEqual(["dg", "dg-core"]);
	});

	test("a rollback to a Bun-only version restores the Bun-only layout", async () => {
		box = scratch("front-rollback");
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env: hermeticEnv(box, { DG_FRONT: "0" }) });
		restore?.();
		await installCompiled(box.root, serve("7.1.0").picked, "linux", { env: hermeticEnv(box) });
		expect(versionFiles(box.root, "7.1.0")).toEqual(["dg", "dg-core"]);
		restore?.();
		const again = serve("7.0.0");
		await installCompiled(box.root, again.picked, "linux", { env: hermeticEnv(box) });
		const bin = join(box.directory, "bin");
		writeDgLink(bin, box.root, "7.0.0", "linux");

		expect(again.calls).toEqual([]);
		expect(readCurrent(box.root, "bin")).toBe("7.0.0");
		expect(read(join(bin, "dg"))).toBe(bunBody("7.0.0"));
		expect(existsSync(join(box.root, "bin", "current", "dg-core"))).toBe(false);
	});

	test("installing again with the opt-out turns an installed front door layout into the Bun-only layout", async () => {
		box = scratch("front-uninstall");
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env: hermeticEnv(box) });
		expect(versionFiles(box.root, "7.0.0")).toEqual(["dg", "dg-core"]);
		restore?.();
		const again = serve("7.0.0");
		await installCompiled(box.root, again.picked, "linux", { env: hermeticEnv(box, { DG_FRONT: "0" }) });

		expect(again.calls).toEqual([]);
		expect(versionFiles(box.root, "7.0.0")).toEqual(["dg"]);
		expect(read(versionProgramPath(box.root, "7.0.0", "linux"))).toBe(bunBody("7.0.0"));
		expect(Bun.spawnSync([versionProgramPath(box.root, "7.0.0", "linux"), "--version"]).stdout.toString().trim()).toBe("7.0.0");
	});

	test("installing the same version again with the front door on changes nothing", async () => {
		box = scratch("front-same");
		const env = hermeticEnv(box);
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env });
		restore?.();
		const again = serve("7.0.0");
		await installCompiled(box.root, again.picked, "linux", { env });

		expect(again.calls).toEqual([]);
		expect(versionFiles(box.root, "7.0.0")).toEqual(["dg", "dg-core"]);
	});
});

function updateDeps(tree: Scratch, bin: string, env: Record<string, string>): { deps: UpdateDeps; lines: string[] } {
	const lines: string[] = [];
	const deps: UpdateDeps = {
		platform: "linux",
		claudeHome: join(tree.directory, "claude"),
		codexHome: join(tree.directory, "codex"),
		install: async (_target, version) => {
			await installCompiled(tree.root, serve(version).picked, "linux", { env });
		},
		newestVersion: async () => "7.1.0",
		installedVersion: () => readCurrent(tree.root, "bin"),
		finishLayout: (version) => {
			writeDgLink(bin, tree.root, version, "linux");
			return { status: 0, stderr: "" };
		},
		stagedExtensions: () => ({}),
		cliOnly: () => true,
		which: () => null,
		run: () => ({ status: 0, stdout: "", stderr: "" }),
		doctor: async () => ({ items: [], ok: true }),
		log: (line) => lines.push(line),
	};
	return { deps, lines };
}

describe.skipIf(!POSIX)("dg update on a default install", () => {
	test("updates both binaries and the hooks launcher runs the new front door", async () => {
		box = scratch("front-update-run");
		const bin = join(box.directory, "bin");
		const env = hermeticEnv(box);
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env });
		writeDgLink(bin, box.root, "7.0.0", "linux");
		restore?.();
		expect(Bun.spawnSync([join(bin, "dg"), "hooks", "run", "pr-confirm"]).stdout.toString().trim()).toBe("FRONT 7.0.0 hooks run pr-confirm");

		const { deps, lines } = updateDeps(box, bin, env);
		const code = await runUpdate({}, deps);

		expect(code, lines.join("\n")).toBe(0);
		const next = installLayout({ root: box.root, version: "7.1.0", platform: "linux" });
		expect(read(next.dg)).toBe(frontBody("7.1.0"));
		expect(read(next.dgCore)).toBe(bunBody("7.1.0"));
		expect(readlinkSync(join(bin, "dg"))).toBe(join(box.root, "bin", "current", "dg"));
		expect(Bun.spawnSync([join(bin, "dg"), "hooks", "run", "pr-confirm"]).stdout.toString().trim()).toBe("FRONT 7.1.0 hooks run pr-confirm");
		expect(Bun.spawnSync([next.dgCore, "--version"]).stdout.toString().trim()).toBe("7.1.0");
	});

	test("under DG_FRONT=0 the update leaves the Bun-only layout", async () => {
		box = scratch("front-update-run-off");
		const bin = join(box.directory, "bin");
		const env = hermeticEnv(box, { DG_FRONT: "0" });
		await installCompiled(box.root, serve("7.0.0").picked, "linux", { env });
		writeDgLink(bin, box.root, "7.0.0", "linux");
		restore?.();

		const { deps, lines } = updateDeps(box, bin, env);
		const code = await runUpdate({}, deps);

		expect(code, lines.join("\n")).toBe(0);
		expect(versionFiles(box.root, "7.1.0")).toEqual(["dg"]);
		expect(Bun.spawnSync([join(bin, "dg"), "hooks", "run", "pr-confirm"]).stdout.toString().trim()).toBe("BUN 7.1.0 hooks run pr-confirm");
	});
});

describe.skipIf(!POSIX)("hook registrations", () => {
	test("run through <bin>/dg after a default install, and no settings file names dg-core", async () => {
		box = scratch("front-hooks");
		const world = settingsWorld();
		try {
			const env = { ...fenceEnv(), DG_HOME: world.dgHome };
			const paths = resolveDgPaths({ homeDir: world.home, env });
			await world.cli(["enable", "spelling", "format", "--runtime", "claude"], { launcher: join(paths.binDir, "dg-skills") });
			await installCompiled(paths.dataDir, serve("7.0.0").picked, "linux", { env });
			await finishLauncherLayout("7.0.0", { paths, home: world.home, env: {}, platform: "linux", log: () => {} });
			const settings = world.text(world.paths.claude);
			const launcher = cliLauncher(paths.binDir, "linux");

			expect(settings).toContain(ownedCommand(launcher, "spelling"));
			expect(settings).toContain(ownedCommand(launcher, "format"));
			expect(settings).not.toContain("dg-core");
			expect(versionFiles(paths.dataDir, "7.0.0")).toEqual(["dg", "dg-core"]);
			expect(Bun.spawnSync([launcher, "hooks", "run", "spelling"]).stdout.toString().trim()).toBe("FRONT 7.0.0 hooks run spelling");
		} finally {
			world.cleanup();
		}
	});
});

describe("writeDgLink on Windows", () => {
	const seedVersion = (tree: Scratch, version: string, files: string[]): void => {
		mkdirSync(join(tree.root, "bin", version), { recursive: true });
		for (const file of files) writeFileSync(join(tree.root, "bin", version, file), `${file} ${version}`);
	};
	const inode = (path: string): bigint => statSync(path, { bigint: true }).ino;

	test("hard links dg.exe and dg-core.exe next to each other when the version has a front door", () => {
		box = scratch("front-win-link");
		const bin = join(box.directory, "bin");
		seedVersion(box, "7.1.0", ["dg.exe", "dg-core.exe"]);
		writeDgLink(bin, box.root, "7.1.0", "win32");

		expect(inode(join(bin, "dg.exe"))).toBe(inode(join(box.root, "bin", "7.1.0", "dg.exe")));
		expect(inode(join(bin, "dg-core.exe"))).toBe(inode(join(box.root, "bin", "7.1.0", "dg-core.exe")));
	});

	test("an update moves both links to the new version", () => {
		box = scratch("front-win-update");
		const bin = join(box.directory, "bin");
		seedVersion(box, "7.0.0", ["dg.exe", "dg-core.exe"]);
		seedVersion(box, "7.1.0", ["dg.exe", "dg-core.exe"]);
		writeDgLink(bin, box.root, "7.0.0", "win32");
		writeDgLink(bin, box.root, "7.1.0", "win32");

		expect(read(join(bin, "dg.exe"))).toBe("dg.exe 7.1.0");
		expect(read(join(bin, "dg-core.exe"))).toBe("dg-core.exe 7.1.0");
		expect(readdirSync(bin).filter((name) => name.endsWith(".old") === false).sort()).toEqual(["dg-core.exe", "dg.exe"]);
	});

	test("a rollback to a Bun-only version removes the dg-core.exe link and keeps dg.exe", () => {
		box = scratch("front-win-rollback");
		const bin = join(box.directory, "bin");
		seedVersion(box, "7.0.0", ["dg.exe"]);
		seedVersion(box, "7.1.0", ["dg.exe", "dg-core.exe"]);
		writeDgLink(bin, box.root, "7.1.0", "win32");
		writeDgLink(bin, box.root, "7.0.0", "win32");

		expect(read(join(bin, "dg.exe"))).toBe("dg.exe 7.0.0");
		expect(readdirSync(bin).filter((name) => !name.endsWith(".old"))).toEqual(["dg.exe"]);
	});

	test("keeps a dg-core.exe that dg did not write, with one warning", () => {
		box = scratch("front-win-foreign");
		const bin = join(box.directory, "bin");
		seedVersion(box, "7.1.0", ["dg.exe", "dg-core.exe"]);
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-core.exe"), "someone else");
		const lines: string[] = [];
		writeDgLink(bin, box.root, "7.1.0", "win32", (line) => lines.push(line));

		expect(read(join(bin, "dg-core.exe"))).toBe("someone else");
		expect(lines).toEqual([`dg: kept ${join(bin, "dg-core.exe")}; it is not a dg launcher. Remove it or rename it, then run dg install again`]);
	});

	test("on POSIX a front door version needs no extra link: dg stays one symlink into current", () => {
		box = scratch("front-posix-link");
		const bin = join(box.directory, "bin");
		writeDgLink(bin, box.root, "7.1.0", "linux");

		expect(readdirSync(bin)).toEqual(["dg"]);
		expect(lstatSync(join(bin, "dg")).isSymbolicLink()).toBe(true);
	});
});

const BOOTSTRAP_VERSION = "1.27.0";
const posixBootstrap = describe.skipIf(!POSIX);

function frontFixture(tree: string, name: string, body: string): string {
	const file = join(tree, name);
	writeFileSync(file, body);
	return file;
}

const bootstrapFront = (asset: string, opts: { exit?: number; printed?: string; marker?: boolean } = {}): string =>
	`#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then ${opts.marker ? 'echo ran >> "$STUBDIR/front-ran"; ' : ""}${opts.exit ? `exit ${opts.exit}` : `echo "${opts.printed ?? BOOTSTRAP_VERSION}"; exit 0`}; fi\nprintf 'FAKE_DG %s\\n' "${asset}"\nfor arg in "$@"; do printf 'FAKE_ARG %s\\n' "$arg"; done\n`;

async function bootstrapWithFront(
	options: Parameters<typeof runBootstrap>[0] & { front?: string | null; frontSum?: "match" | "wrong"; asset?: string; frontGz?: boolean } = {},
) {
	const { front = bootstrapFront("dg-front-linux-x64"), frontSum = "match", asset = "dg-front-linux-x64", frontGz = false, ...rest } = options;
	const stage = scratch("bootstrap-front-files");
	box = stage;
	const serveMap: Record<string, string> = {};
	const extra: Record<string, string | null> = {};
	if (front !== null) {
		const sum = frontSum === "wrong" ? "0".repeat(64) : hashOf(front);
		extra[asset] = sum;
		if (frontGz) {
			const packed = Buffer.from(Bun.gzipSync(front));
			serveMap[`${asset}.gz`] = frontFixture(stage.directory, `${asset}.gz`, "");
			writeFileSync(serveMap[`${asset}.gz`] as string, packed);
			extra[`${asset}.gz`] = hashOf(packed);
		} else {
			serveMap[asset] = frontFixture(stage.directory, asset, front);
		}
	}
	return runBootstrap({
		...rest,
		serve: { ...serveMap, ...(rest.serve ?? {}) },
		extraAssets: { ...extra, ...(rest.extraAssets ?? {}) },
	});
}

const versionDirOf = (run: { root: string; version: string }): string => join(run.root, "data", "bin", run.version);
const noFrontDoorLines = (stderr: string): string[] => stderr.split("\n").filter((line) => line.includes("front door"));

posixBootstrap("bootstrap.sh places the front door at dg by default", () => {
	test("puts the front door at dg and the Bun binary at dg-core, and runs dg install through the front door", async () => {
		const run = await bootstrapWithFront();

		expect(run.code, run.stderr).toBe(0);
		expect(readdirSync(versionDirOf(run)).sort()).toEqual(["dg", "dg-core"]);
		expect(read(join(versionDirOf(run), "dg"))).toContain("dg-front-linux-x64");
		expect(read(join(versionDirOf(run), "dg-core"))).toContain("dg-linux-x64");
		expect(programRun(run.stdout)?.asset).toBe("dg-front-linux-x64");
		expect(readlinkSync(join(run.root, "bin", "dg"))).toBe(join(run.root, "data", "bin", "current", "dg"));
		expect(noFrontDoorLines(run.stderr)).toEqual([]);
	});

	test("prefers the .gz front door asset and verifies the unpacked bytes", async () => {
		const run = await bootstrapWithFront({ frontGz: true });

		expect(run.code, run.stderr).toBe(0);
		expect(run.requests.some((url) => url.endsWith("/dg-front-linux-x64.gz"))).toBe(true);
		expect(run.requests.some((url) => url.endsWith("/dg-front-linux-x64"))).toBe(false);
		expect(readdirSync(versionDirOf(run)).sort()).toEqual(["dg", "dg-core"]);
	});

	for (const [label, options, asset] of [
		["linux x64", { os: "Linux", arch: "x86_64" }, "dg-front-linux-x64"],
		["linux x64 without avx2 shares the x64 front door", { os: "Linux", arch: "x86_64", avx2: false }, "dg-front-linux-x64"],
		["linux arm64", { os: "Linux", arch: "aarch64" }, "dg-front-linux-arm64"],
		["macOS x64", { os: "Darwin", arch: "x86_64" }, "dg-front-osx-x64"],
		["macOS arm64", { os: "Darwin", arch: "arm64" }, "dg-front-osx-arm64"],
	] as const) {
		test(`${label} fetches ${asset}`, async () => {
			const run = await bootstrapWithFront({ ...options, asset, front: bootstrapFront(asset) });

			expect(run.code, run.stderr).toBe(0);
			expect(readdirSync(versionDirOf(run)).sort()).toEqual(["dg", "dg-core"]);
			expect(run.requests.some((url) => url.endsWith(`/${asset}`))).toBe(true);
		});
	}
});

posixBootstrap("bootstrap.sh opt-outs", () => {
	test("DG_FRONT=0 keeps the Bun-only layout and never asks for the front door", async () => {
		const run = await bootstrapWithFront({ env: { DG_FRONT: "0" } });

		expect(run.code, run.stderr).toBe(0);
		expect(readdirSync(versionDirOf(run))).toEqual(["dg"]);
		expect(run.requests.filter((url) => url.includes("dg-front-"))).toEqual([]);
		expect(programRun(run.stdout)?.asset).toBe("dg-linux-x64");
		expect(noFrontDoorLines(run.stderr)).toEqual([]);
	});

	test("front.enabled = false in config.toml keeps the Bun-only layout", async () => {
		const run = await bootstrapWithFront({
			seed: (root) => {
				mkdirSync(join(root, "config"), { recursive: true });
				writeFileSync(join(root, "config", "config.toml"), '# front door\n[front]\nenabled = false\n\n[browser]\nmode = "auto"\n');
			},
		});

		expect(run.code, run.stderr).toBe(0);
		expect(readdirSync(versionDirOf(run))).toEqual(["dg"]);
		expect(run.requests.filter((url) => url.includes("dg-front-"))).toEqual([]);
	});

	test("an enabled key in another table does not turn the front door off", async () => {
		const run = await bootstrapWithFront({
			seed: (root) => {
				mkdirSync(join(root, "config"), { recursive: true });
				writeFileSync(join(root, "config", "config.toml"), "[hooks]\nenabled = false\n");
			},
		});

		expect(readdirSync(versionDirOf(run)).sort()).toEqual(["dg", "dg-core"]);
	});
});

posixBootstrap("bootstrap.sh falls back to the Bun binary at dg", () => {
	const expectBunOnly = (run: Awaited<ReturnType<typeof bootstrapWithFront>>): void => {
		expect(run.code, run.stderr).toBe(0);
		expect(readdirSync(versionDirOf(run))).toEqual(["dg"]);
		expect(read(join(versionDirOf(run), "dg"))).toContain("FAKE_DG");
		expect(programRun(run.stdout)?.asset).toBe("dg-linux-x64");
		expect(noFrontDoorLines(run.stderr)).toHaveLength(1);
	};

	test("a release with no front door asset", async () => {
		expectBunOnly(await bootstrapWithFront({ front: null }));
	});

	test("a front door asset that cannot be downloaded", async () => {
		expectBunOnly(await bootstrapWithFront({ extraAssets: { "dg-front-linux-x64": hashOf("never served") }, front: null }));
	});

	test("a front door whose sha256 does not match, which is never run", async () => {
		const run = await bootstrapWithFront({ front: bootstrapFront("dg-front-linux-x64", { marker: true }), frontSum: "wrong" });

		expectBunOnly(run);
		expect(present(join(run.dir, "front-ran"))).toBe(false);
		expect(run.stderr).toContain("checksum mismatch");
	});

	test("a front door that exits non-zero on --version", async () => {
		expectBunOnly(await bootstrapWithFront({ front: bootstrapFront("dg-front-linux-x64", { exit: 3 }) }));
	});

	test("a front door that prints another version", async () => {
		expectBunOnly(await bootstrapWithFront({ front: bootstrapFront("dg-front-linux-x64", { printed: "0.0.1" }) }));
	});

	test("a front door that hangs on --version, stopped by the timeout", async () => {
		const hang = `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then exec sleep 60; fi\n`;
		const started = Date.now();
		const run = await bootstrapWithFront({ front: hang, env: { DG_FRONT_TIMEOUT: "1" } });

		expectBunOnly(run);
		expect(Date.now() - started).toBeLessThan(30_000);
	});
});

describe("bootstrap.ps1 places the front door at dg.exe by default", () => {
	const script = readFileSync(join(import.meta.dir, "..", "bootstrap.ps1"), "utf8");
	const at = (needle: string): number => script.indexOf(needle);

	test("maps the Windows keys onto the win-x64 and win-arm64 front doors", () => {
		expect(script).toContain('"dg-front-win-$arch.exe"');
	});

	test("honors DG_FRONT=0 and front.enabled = false", () => {
		expect(script).toContain('"$env:DG_FRONT".Trim().ToLowerInvariant()');
		expect(script).toContain("$line -eq '[front]'");
	});

	test("verifies the front door sha256 before it runs it, and runs it with a timeout", () => {
		expect(at("Assert-DgSha256 $frontDownloaded")).toBeGreaterThan(-1);
		expect(script.lastIndexOf("Test-DgFrontVersion $dg")).toBeGreaterThan(at("Assert-DgSha256 $frontDownloaded"));
		expect(script).toContain("WaitForExit(");
	});

	test("hard links dg-core.exe next to dg.exe and removes a stale link", () => {
		expect(script).toContain("dg-core.exe");
		expect(script).toMatch(/\.dg-core\.exe\.\*\.old/);
	});

	test("a missing asset, a failed download or a failed start keeps the Bun binary with one line and never throws", () => {
		expect(script).toMatch(/Write-Host "dg: the front door was not installed/);
	});
});

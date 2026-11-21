import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { installCompiled, removeOldLaunchers, versionProgramPath, writeDgLink } from "../src/install/compiled";
import { hooksHome } from "../src/install/layout";
import { readCurrent } from "../src/install/current";
import { compiledAssetName, platformKey } from "../src/utils/lib";
import { oldShimText } from "./dg-launcher-fixtures";
import { fakeProgramScript, RELEASE_BASE, type Scratch, scratch, sha256, stubFetch } from "./release-fixtures";

const POSIX = process.platform !== "win32";

let box: Scratch | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
	restore?.();
	restore = undefined;
	box?.cleanup();
	box = undefined;
});

function release(version: string, body: string, sumsBody = body) {
	const assetName = compiledAssetName(platformKey());
	const url = `${RELEASE_BASE}/v${version}/${assetName}`;
	const sumsUrl = `${RELEASE_BASE}/v${version}/SHA256SUMS`;
	const stub = stubFetch({ [url]: body, [sumsUrl]: `${sha256(sumsBody)}  ${assetName}\n` });
	restore = stub.restore;
	return { picked: { version, assetName, url, sumsUrl }, calls: stub.calls };
}

describe("installCompiled", () => {
	test.skipIf(!POSIX)("installs bin/<version>/dg, links bin/current and returns the program path", async () => {
		box = scratch("compiled");
		const { picked } = release("7.0.0", fakeProgramScript("7.0.0"));
		const path = await installCompiled(box.root, picked);
		expect(path).toBe(versionProgramPath(box.root, "7.0.0"));
		expect(readCurrent(box.root, "bin")).toBe("7.0.0");
		expect(lstatSync(path).mode & 0o777).toBe(0o755);
	});

	test.skipIf(!POSIX)("a checksum mismatch installs nothing and links nothing", async () => {
		box = scratch("compiled-sum");
		const { picked } = release("7.0.0", fakeProgramScript("7.0.0"), "other");
		await expect(installCompiled(box.root, picked)).rejects.toThrow(/checksum|SHA256/i);
		expect(existsSync(join(box.root, "bin", "7.0.0"))).toBe(false);
		expect(readCurrent(box.root, "bin")).toBeUndefined();
	});

	test.skipIf(!POSIX)("a staged program whose --version fails leaves the old link in place", async () => {
		box = scratch("compiled-fail");
		const first = release("7.0.0", fakeProgramScript("7.0.0"));
		await installCompiled(box.root, first.picked);
		restore?.();
		const { picked } = release("7.1.0", fakeProgramScript("7.1.0", undefined, 3));
		await expect(installCompiled(box.root, picked)).rejects.toThrow("dg self-check failed");
		expect(readCurrent(box.root, "bin")).toBe("7.0.0");
		expect(existsSync(join(box.root, "bin", "7.1.0"))).toBe(false);
	});

	test.skipIf(!POSIX)("a program that prints another version is refused", async () => {
		box = scratch("compiled-version");
		const { picked } = release("7.1.0", fakeProgramScript("7.0.9"));
		await expect(installCompiled(box.root, picked)).rejects.toThrow("expected 7.1.0, printed 7.0.9");
	});

	test.skipIf(!POSIX)("an installed version is relinked with no download, and the replaced version stays", async () => {
		box = scratch("compiled-relink");
		const a = release("7.0.0", fakeProgramScript("7.0.0"));
		await installCompiled(box.root, a.picked);
		restore?.();
		const b = release("7.1.0", fakeProgramScript("7.1.0"));
		await installCompiled(box.root, b.picked);
		restore?.();
		const again = release("7.0.0", "never fetched");
		await installCompiled(box.root, again.picked);
		expect(again.calls).toEqual([]);
		expect(readCurrent(box.root, "bin")).toBe("7.0.0");
		expect(readdirSync(join(box.root, "bin")).filter((name) => /^\d/.test(name)).sort()).toEqual(["7.0.0", "7.1.0"]);
	});

	test.skipIf(!POSIX)("keeps only the new and the replaced versions", async () => {
		box = scratch("compiled-prune");
		for (const version of ["7.0.0", "7.1.0", "7.2.0"]) {
			const next = release(version, fakeProgramScript(version));
			await installCompiled(box.root, next.picked);
			restore?.();
		}
		expect(readdirSync(join(box.root, "bin")).filter((name) => /^\d/.test(name)).sort()).toEqual(["7.1.0", "7.2.0"]);
	});
});

describe("writeDgLink", () => {
	test.skipIf(!POSIX)("links <bin>/dg to <root>/bin/current/dg", () => {
		box = scratch("dg-link");
		const bin = join(box.directory, "bin");
		writeDgLink(bin, box.root, "7.0.0", "linux");
		expect(readlinkSync(join(bin, "dg"))).toBe(join(box.root, "bin", "current", "dg"));
	});

	test.skipIf(!POSIX)("replaces an old 6.3 dg shim", () => {
		box = scratch("dg-link-shim");
		const bin = join(box.directory, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), oldShimText(box.root, "dg"));
		writeDgLink(bin, box.root, "7.0.0", "linux");
		expect(lstatSync(join(bin, "dg")).isSymbolicLink()).toBe(true);
	});

	test.skipIf(!POSIX)("keeps a dg file of another tool, with one warning", () => {
		box = scratch("dg-link-foreign");
		const bin = join(box.directory, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), "#!/bin/sh\necho other\n");
		const lines: string[] = [];
		writeDgLink(bin, box.root, "7.0.0", "linux", (line) => lines.push(line));
		expect(readFileSync(join(bin, "dg"), "utf8")).toBe("#!/bin/sh\necho other\n");
		expect(lines).toEqual([`dg: kept ${join(bin, "dg")}; it is not a dg launcher. Remove it or rename it, then run dg install again`]);
	});

	test.skipIf(!POSIX)("on Windows a failed hard link puts the renamed dg.exe back and rethrows", () => {
		const tree = scratch("dg-link-rollback");
		box = tree;
		const bin = join(tree.directory, "bin");
		mkdirSync(bin, { recursive: true });
		const shim = `@echo off\r\n"${tree.root}\\runtime\\current\\bun.exe" "${tree.root}\\lib\\current\\dg.js" dg %*\r\n`;
		writeFileSync(join(bin, "dg.exe"), shim);
		expect(() => writeDgLink(bin, tree.root, "7.0.0", "win32")).toThrow();
		expect(readdirSync(bin)).toEqual(["dg.exe"]);
		expect(readFileSync(join(bin, "dg.exe"), "utf8")).toBe(shim);
	});

	test.skipIf(!POSIX)("a second run keeps the same link", () => {
		box = scratch("dg-link-again");
		const bin = join(box.directory, "bin");
		writeDgLink(bin, box.root, "7.0.0", "linux");
		writeDgLink(bin, box.root, "7.0.0", "linux");
		expect(readlinkSync(join(bin, "dg"))).toBe(join(box.root, "bin", "current", "dg"));
	});
});

describe("removeOldLaunchers", () => {
	test.skipIf(!POSIX)("removes the 6.3 shims and their version stamps, and keeps a foreign file", () => {
		box = scratch("old-launchers");
		const bin = join(box.directory, "bin");
		mkdirSync(bin, { recursive: true });
		for (const name of ["dg-skills", "dg-agent"]) {
			writeFileSync(join(bin, name), oldShimText(box.root, name));
			chmodSync(join(bin, name), 0o755);
			writeFileSync(join(bin, `.${name}.version`), "6.3.1");
		}
		writeFileSync(join(bin, "dg-daemon"), "#!/bin/sh\necho mine\n");
		const lines: string[] = [];
		const removed = removeOldLaunchers(bin, box.root, "linux", { warn: (line) => lines.push(line) });
		expect(removed.sort()).toEqual([join(bin, "dg-agent"), join(bin, "dg-skills")]);
		expect(readdirSync(bin).sort()).toEqual(["dg-daemon"]);
		expect(lines).toEqual([`dg: kept ${join(bin, "dg-daemon")}; it is not a dg launcher. dg no longer uses that name`]);
	});

	test.skipIf(!POSIX)("removes a link into the dg data dir and a dangling link", () => {
		box = scratch("old-links");
		const bin = join(box.directory, "bin");
		mkdirSync(join(box.root, "bin", "current"), { recursive: true });
		writeFileSync(join(box.root, "bin", "current", "dg"), "x");
		mkdirSync(bin, { recursive: true });
		symlinkSync(join(box.root, "bin", "current", "dg"), join(bin, "dg-skills"));
		symlinkSync(join(box.directory, "gone"), join(bin, "dg-agent"));
		removeOldLaunchers(bin, box.root, "linux");
		expect(readdirSync(bin)).toEqual([]);
	});

	test.skipIf(!POSIX)("keepCmd leaves .cmd files for the 6.3 bridge step on Windows", () => {
		box = scratch("old-cmd");
		const bin = join(box.directory, "bin");
		mkdirSync(bin, { recursive: true });
		const cmd = `@echo off\r\n"${box.root}\\runtime\\current\\bun.exe" "${box.root}\\lib\\current\\dg.js" dg-skills %*\r\n`;
		writeFileSync(join(bin, "dg-skills.cmd"), cmd);
		writeFileSync(join(bin, "dg.cmd"), cmd.replace("dg-skills", "dg"));
		removeOldLaunchers(bin, box.root, "win32", { keepCmd: true });
		expect(readdirSync(bin).sort()).toEqual(["dg-skills.cmd", "dg.cmd"]);
		removeOldLaunchers(bin, box.root, "win32");
		expect(readdirSync(bin)).toEqual([]);
	});
});

describe("hooksHome", () => {
	test("under the test runner gives no home when HOME is the account home, so a test never edits real settings", () => {
		expect(hooksHome({ NODE_ENV: "test", HOME: "/home/u" }, () => "/home/u")).toBeUndefined();
		expect(hooksHome({ NODE_ENV: "test" }, () => "/home/u")).toBeUndefined();
	});

	test("under the test runner gives a temp HOME that is not the account home", () => {
		expect(hooksHome({ NODE_ENV: "test", HOME: "/tmp/x/home" }, () => "/home/u")).toBe("/tmp/x/home");
	});
});

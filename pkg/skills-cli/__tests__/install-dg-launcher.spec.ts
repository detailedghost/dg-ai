import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { compiledProgramPath } from "@dg/common/node/program";
import { versionProgramPath, writeDgLink } from "../src/install/compiled";
import { holdsOtherFile, isDgLauncher } from "../src/install/dg-launcher";
import {
	generatedLauncher,
	isReplacedLauncher,
	KEPT_SENTENCE,
	LAUNCHER_FIXTURES,
	launcherMarker,
	makeArea,
	snapshot,
} from "./dg-launcher-fixtures";

const posix = describe.skipIf(process.platform === "win32");

let area: string;
let cleanup: () => void;
let bin: string;
let root: string;

beforeEach(() => {
	({ area, cleanup } = makeArea("dg-launcher"));
	bin = join(area, "bin");
	root = join(area, "root");
});

afterEach(() => cleanup());

describe("isDgLauncher", () => {
	test("is true for a 6.3 shim and false for a missing path", () => {
		const path = join(area, "dg");
		writeFileSync(path, generatedLauncher(area, "dg", "linux"));

		expect(isDgLauncher(path, "linux", root)).toBe(true);
		expect(isDgLauncher(join(bin, "nothing"), "linux", root)).toBe(false);
	});

	test("is true when the shim holds an added line", () => {
		const path = join(area, "dg");
		writeFileSync(path, `${generatedLauncher(area, "dg", "linux")}# added\n`);

		expect(isDgLauncher(path, "linux", root)).toBe(true);
	});

	test("is false for an empty file, a directory, a foreign script and a file with a NUL byte in its first bytes", () => {
		const empty = join(area, "empty");
		const dir = join(area, "dir");
		const script = join(area, "script");
		const nul = join(area, "nul");
		writeFileSync(empty, "");
		mkdirSync(dir);
		writeFileSync(script, '#!/bin/sh\nexec dg-skills "$@"\n');
		writeFileSync(nul, Buffer.concat([Buffer.from([0]), Buffer.from(launcherMarker("linux"))]));

		for (const path of [empty, dir, script, nul])
			expect([path, isDgLauncher(path, "linux", root)]).toEqual([path, false]);
	});

	test("reads the win32 marker for a dg.cmd and the posix marker otherwise", () => {
		const cmd = join(area, "dg.cmd");
		writeFileSync(cmd, generatedLauncher(area, "dg", "win32"));

		expect(isDgLauncher(cmd, "win32", root)).toBe(true);
		expect(isDgLauncher(cmd, "linux", root)).toBe(false);
	});

	test.skipIf(process.platform === "win32")("is true for a link into <root>/bin and false for a link elsewhere", () => {
		mkdirSync(bin, { recursive: true });
		const inside = join(bin, "inside");
		const outside = join(bin, "outside");
		symlinkSync(join(root, "bin", "current", "dg"), inside);
		symlinkSync(join(area, "elsewhere", "dg"), outside);

		expect(isDgLauncher(inside, "linux", root)).toBe(true);
		expect(isDgLauncher(outside, "linux", root)).toBe(false);
	});

	test("is true for a hard link to an installed dg.exe", () => {
		const installed = versionProgramPath(root, "7.0.0", "win32");
		mkdirSync(join(root, "bin", "7.0.0"), { recursive: true });
		writeFileSync(installed, "MZ");
		mkdirSync(bin, { recursive: true });
		linkSync(installed, join(bin, "dg.exe"));
		writeFileSync(join(bin, "copy.exe"), "MZ");

		expect(isDgLauncher(join(bin, "dg.exe"), "win32", root)).toBe(true);
		expect(isDgLauncher(join(bin, "copy.exe"), "win32", root)).toBe(false);
	});
});

describe("writeDgLink on win32 paths", () => {
	test("hard links dg.exe to the installed version and replaces an older hard link", () => {
		for (const version of ["7.0.0", "7.1.0"]) {
			mkdirSync(join(root, "bin", version), { recursive: true });
			writeFileSync(versionProgramPath(root, version, "win32"), `MZ ${version}`);
		}

		writeDgLink(bin, root, "7.0.0", "win32");
		writeDgLink(bin, root, "7.1.0", "win32");

		expect(statSync(join(bin, "dg.exe")).ino).toBe(statSync(versionProgramPath(root, "7.1.0", "win32")).ino);
		expect(readFileSync(join(bin, "dg.exe"), "utf8")).toBe("MZ 7.1.0");
	});

	test("keeps a dg.exe that is not a dg launcher, with the kept warning", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg.exe"), "MZ other tool");
		const warnings: string[] = [];

		writeDgLink(bin, root, "7.0.0", "win32", (line) => void warnings.push(line));

		expect(readFileSync(join(bin, "dg.exe"), "utf8")).toBe("MZ other tool");
		expect(warnings).toEqual([KEPT_SENTENCE(join(bin, "dg.exe"))]);
	});

	test("ignores a dg file with no extension: no warning and the file stays", () => {
		mkdirSync(join(root, "bin", "7.0.0"), { recursive: true });
		writeFileSync(versionProgramPath(root, "7.0.0", "win32"), "MZ");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), "other tool");
		const warnings: string[] = [];

		writeDgLink(bin, root, "7.0.0", "win32", (line) => void warnings.push(line));

		expect(warnings).toEqual([]);
		expect(readFileSync(join(bin, "dg"), "utf8")).toBe("other tool");
		expect(existsSync(join(bin, "dg.exe"))).toBe(true);
	});
});

describe("holdsOtherFile", () => {
	test("is false for a missing path and for a link that writeDgLink wrote", () => {
		expect(holdsOtherFile(join(bin, "dg"), "linux", root)).toBe(false);

		writeDgLink(bin, root, "7.0.0", "linux");

		expect(holdsOtherFile(join(bin, "dg"), "linux", root)).toBe(false);
	});

	test("is true for a file that is not a dg launcher", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), "#!/bin/sh\necho other\n");

		expect(holdsOtherFile(join(bin, "dg"), "linux", root)).toBe(true);
	});

	test.skipIf(process.platform === "win32")("is false for a dg link with no target", () => {
		mkdirSync(bin, { recursive: true });
		symlinkSync(join(area, "missing-target"), join(bin, "dg"));

		expect(holdsOtherFile(join(bin, "dg"), "linux", root)).toBe(false);
	});
});

posix("writeDgLink with a dg path that holds something else", () => {
	for (const fixture of LAUNCHER_FIXTURES) {
		test.skipIf(fixture.skip === true)(
			`${fixture.outcome === "kept" ? "keeps" : "replaces"} ${fixture.name}`,
			() => {
				const dest = join(bin, "dg");
				const untouched = fixture.setup(dest, area);
				const before = snapshot(dest);
				const targets = untouched.map((path) => snapshot(path));
				const warnings: string[] = [];

				writeDgLink(bin, root, "7.0.0", "linux", (line) => void warnings.push(line));

				expect(untouched.map((path) => snapshot(path))).toEqual(targets);
				if (fixture.outcome === "kept") {
					expect(snapshot(dest)).toEqual(before);
					expect(warnings).toEqual([KEPT_SENTENCE(dest)]);
				} else {
					expect(isReplacedLauncher(dest, root, "linux")).toBe(true);
					expect(warnings).toEqual([]);
				}
			},
		);
	}

	test("a kept dg file keeps its mode and its bytes", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), "#!/bin/sh\necho other\n", { mode: 0o640 });
		const before = snapshot(join(bin, "dg"));

		expect(() => writeDgLink(bin, root, "7.0.0", "linux", () => {})).not.toThrow();

		expect(snapshot(join(bin, "dg"))).toEqual(before);
		expect(readdirSync(bin)).toEqual(["dg"]);
	});

	test("the default warning goes to stderr", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), "other tool");
		const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			writeDgLink(bin, root, "7.0.0", "linux");
			const text = spy.mock.calls.map((call) => String(call[0])).join("");
			expect(text).toContain(KEPT_SENTENCE(join(bin, "dg")));
		} finally {
			spy.mockRestore();
		}
	});

	test("links dg to the current program and leaves no staged file behind", () => {
		writeDgLink(bin, root, "7.0.0", "linux");

		expect(readlinkSync(join(bin, "dg"))).toBe(compiledProgramPath(root, "linux"));
		expect(lstatSync(join(bin, "dg")).isSymbolicLink()).toBe(true);
		expect(readdirSync(bin)).toEqual(["dg"]);
	});
});

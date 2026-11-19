import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDgLauncher, writeShims } from "../src/install/shims";
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
const OTHERS = ["dg-skills", "dg-agent", "dg-daemon"] as const;

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
	test("is true for a launcher that writeShims wrote and false for a missing path", () => {
		writeShims(bin, root, "linux", () => {});

		expect(isDgLauncher(join(bin, "dg"), "linux")).toBe(true);
		expect(isDgLauncher(join(bin, "nothing"), "linux")).toBe(false);
	});

	test("is true when the launcher holds an added line", () => {
		const path = join(area, "dg");
		writeFileSync(path, `${generatedLauncher(area, "dg", "linux")}# added\n`);

		expect(isDgLauncher(path, "linux")).toBe(true);
	});

	test("is false for an empty file, a directory, a foreign script and a file with a NUL byte in its first bytes", () => {
		const empty = join(area, "empty");
		const dir = join(area, "dir");
		const script = join(area, "script");
		const nul = join(area, "nul");
		writeFileSync(empty, "");
		mkdirSync(dir);
		writeFileSync(script, '#!/bin/sh\nexec dg-skills "$@"\n');
		writeFileSync(
			nul,
			Buffer.concat([Buffer.from([0]), Buffer.from(launcherMarker("linux"))]),
		);

		for (const path of [empty, dir, script, nul])
			expect([path, isDgLauncher(path, "linux")]).toEqual([path, false]);
	});

	test("reads the win32 marker for a dg.cmd and the posix marker otherwise", () => {
		const cmd = join(area, "dg.cmd");
		writeFileSync(cmd, generatedLauncher(area, "dg", "win32"));

		expect(isDgLauncher(cmd, "win32")).toBe(true);
		expect(isDgLauncher(cmd, "linux")).toBe(false);
	});
});

describe("writeShims", () => {
	test("writes dg, dg-skills, dg-agent and dg-daemon, and the dg launcher runs the current bundle with its own name", () => {
		writeShims(bin, root, "linux", () => {});

		expect(readdirSync(bin).sort()).toEqual(["dg", ...OTHERS].sort());
		expect(readFileSync(join(bin, "dg"), "utf8")).toContain(
			`/lib/current/dg.js" dg "$@"`,
		);
	});

	test("writes the four .cmd launchers on win32", () => {
		writeShims(bin, root, "win32", () => {});

		expect(readdirSync(bin).sort()).toEqual(
			["dg.cmd", ...OTHERS.map((name) => `${name}.cmd`)].sort(),
		);
	});

	test("adds the dg launcher to an install that has the three others when it runs again", () => {
		mkdirSync(bin);
		for (const name of OTHERS) writeFileSync(join(bin, name), "old launcher");

		writeShims(bin, root, "linux", () => {});

		expect(isDgLauncher(join(bin, "dg"), "linux")).toBe(true);
	});
});

posix("writeShims with a dg path that holds something else", () => {
	for (const fixture of LAUNCHER_FIXTURES) {
		test.skipIf(fixture.skip === true)(
			`${fixture.outcome === "kept" ? "keeps" : "replaces"} ${fixture.name}`,
			() => {
				const dest = join(bin, "dg");
				const untouched = fixture.setup(dest, area);
				const before = snapshot(dest);
				const targets = untouched.map((path) => snapshot(path));
				const warnings: string[] = [];

				writeShims(bin, root, "linux", (line) => void warnings.push(line));

				expect(untouched.map((path) => snapshot(path))).toEqual(targets);
				for (const name of OTHERS)
					expect(isDgLauncher(join(bin, name), "linux")).toBe(true);
				if (fixture.outcome === "kept") {
					expect(snapshot(dest)).toEqual(before);
					expect(warnings.length).toBeGreaterThanOrEqual(1);
					expect(warnings).toContain(KEPT_SENTENCE(dest));
				} else {
					expect(isReplacedLauncher(dest, "linux")).toBe(true);
					expect(warnings).toEqual([]);
				}
			},
		);
	}

	test("a kept dg file keeps its mode and its bytes while dg-skills, dg-agent and dg-daemon are written", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), "#!/bin/sh\necho other\n", { mode: 0o640 });
		const before = snapshot(join(bin, "dg"));

		expect(() => writeShims(bin, root, "linux", () => {})).not.toThrow();

		expect(snapshot(join(bin, "dg"))).toEqual(before);
		expect(readdirSync(bin).sort()).toEqual(["dg", ...OTHERS].sort());
	});

	test("the default warning goes to stderr", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), "other tool");
		const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			writeShims(bin, root);
			const text = spy.mock.calls.map((call) => String(call[0])).join("");
			expect(text).toContain(KEPT_SENTENCE(join(bin, "dg")));
		} finally {
			spy.mockRestore();
		}
	});

	test("applies the rule to the name dg only: a foreign dg-skills file is replaced with no warning", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg-skills"), "other tool");
		const warnings: string[] = [];

		writeShims(bin, root, "linux", (line) => void warnings.push(line));

		expect(isDgLauncher(join(bin, "dg-skills"), "linux")).toBe(true);
		expect(warnings).toEqual([]);
	});
});

describe("writeShims on win32 with files in the launcher folder", () => {
	test("keeps a dg.cmd that is not a dg launcher, writes the three other .cmd files and warns with the dg.cmd path", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg.cmd"), "@echo other tool\r\n");
		const warnings: string[] = [];

		writeShims(bin, root, "win32", (line) => void warnings.push(line));

		expect(readFileSync(join(bin, "dg.cmd"), "utf8")).toBe(
			"@echo other tool\r\n",
		);
		for (const name of OTHERS)
			expect(existsSync(join(bin, `${name}.cmd`))).toBe(true);
		expect(warnings).toContain(KEPT_SENTENCE(join(bin, "dg.cmd")));
	});

	test("replaces a dg.cmd of another root with no warning", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg.cmd"), generatedLauncher(area, "dg", "win32"));
		const warnings: string[] = [];

		writeShims(bin, root, "win32", (line) => void warnings.push(line));

		expect(readFileSync(join(bin, "dg.cmd"), "utf8")).toContain(root);
		expect(warnings).toEqual([]);
	});

	test("ignores a dg file with no extension: no warning and the file stays", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg"), "other tool");
		const warnings: string[] = [];

		writeShims(bin, root, "win32", (line) => void warnings.push(line));

		expect(warnings).toEqual([]);
		expect(readFileSync(join(bin, "dg"), "utf8")).toBe("other tool");
		expect(existsSync(join(bin, "dg.cmd"))).toBe(true);
	});

	test("never removes dg.exe and still removes the exe of the three legacy names", () => {
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "dg.exe"), "MZ other tool");
		for (const name of OTHERS)
			writeFileSync(join(bin, `${name}.exe`), "MZ compiled");

		writeShims(bin, root, "win32", () => {});

		expect(readFileSync(join(bin, "dg.exe"), "utf8")).toBe("MZ other tool");
		for (const name of OTHERS)
			expect(existsSync(join(bin, `${name}.exe`))).toBe(false);
	});
});

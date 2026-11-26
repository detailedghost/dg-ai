import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	checkFloor,
	compareVersions,
	main,
	parseFloor,
	type FloorInput,
} from "../../../scripts/extension-floor-check";
import { git } from "../../../scripts/release-version";
import { readRepoFile } from "./test-support";

const input = (overrides: Partial<FloorInput> = {}): FloorInput => ({
	floor: "8.0.0",
	baseFloor: "7.1.0",
	released: "7.1.0",
	title: "feat(cli)!: lean the cli",
	body: "",
	commits: [],
	...overrides,
});

describe("parseFloor reads the floor from pw-ext-format source", () => {
	test("returns the dotted version", () => {
		expect(
			parseFloor("export const PW_EXT_MIN_EXTENSION_VERSION = [8, 0, 0] as const;"),
		).toBe("8.0.0");
	});

	test("returns null when the constant is missing", () => {
		expect(parseFloor("export const OTHER = [1, 2, 3];")).toBeNull();
	});

	test("reads the committed floor", () => {
		expect(
			parseFloor(readRepoFile("pkg", "common", "src", "pw-ext-format.ts")),
		).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("compareVersions orders dotted versions numerically", () => {
	test.each([
		["8.0.0", "7.1.0", 1],
		["7.1.0", "7.1.0", 0],
		["7.9.0", "7.10.0", -1],
		["1.0.0", "0.99.99", 1],
	])("%s vs %s is %d", (a, b, sign) => {
		expect(Math.sign(compareVersions(a, b))).toBe(sign);
	});
});

describe("compareVersions refuses a segment that is not a non-negative integer", () => {
	test.each([
		["7.1.0-beta.1", "7.1.0"],
		["7.1.0", "7.1.0-beta.1"],
		["7..0", "7.1.0"],
		["", "7.1.0"],
		["7.-1.0", "7.1.0"],
	])("%s vs %s throws", (a, b) => {
		expect(() => compareVersions(a, b)).toThrow(/not a non-negative integer/);
	});

	test("checkFloor throws instead of passing on a prerelease version", () => {
		expect(() => checkFloor(input({ released: "7.1.0-beta.1" }))).toThrow(
			/not a non-negative integer/,
		);
	});
});

describe("checkFloor guards the extension floor", () => {
	test("passes a raised floor equal to the predicted major release", () => {
		expect(checkFloor(input()).ok).toBe(true);
	});

	test("fails when the floor is above the predicted release", () => {
		const result = checkFloor(input({ title: "feat(cli): add a flag" }));
		expect(result.ok).toBe(false);
		expect(result.message).toBe(
			"the floor 8.0.0 is above the version this PR would release, 7.2.0",
		);
	});

	test("predicts from the BREAKING CHANGE footer in the body", () => {
		expect(
			checkFloor(
				input({
					title: "feat(cli): add a flag",
					body: "why\n\nBREAKING CHANGE: new floor",
				}),
			).ok,
		).toBe(true);
	});

	test("predicts from the highest commit since the release tag", () => {
		const commits = [
			{ subject: "fix(cli): a", body: "" },
			{ subject: "feat(cli)!: b", body: "" },
		];
		expect(checkFloor(input({ title: "chore(cli): x", commits })).ok).toBe(true);
	});

	test("predicts the released version when nothing bumps", () => {
		const result = checkFloor(input({ title: "docs(cli): x" }));
		expect(result.ok).toBe(false);
		expect(result.message).toContain("above the version this PR would release, 7.1.0");
	});

	test("fails a changed floor that is not above the released extension", () => {
		const result = checkFloor(
			input({ floor: "7.1.0", baseFloor: "7.0.0", title: "feat(cli): x" }),
		);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(
			"the floor 7.1.0 is not above the released extension 7.1.0; an old extension would pass",
		);
	});

	test("passes an unchanged floor equal to the released version", () => {
		expect(
			checkFloor(
				input({ floor: "8.0.0", baseFloor: "8.0.0", released: "8.0.0", title: "docs(x): y" }),
			).ok,
		).toBe(true);
	});

	test("treats a missing base floor as changed", () => {
		expect(
			checkFloor(input({ floor: "7.1.0", baseFloor: null, title: "feat(cli): x" })).ok,
		).toBe(false);
	});
});

const FLOOR_FILE = join("pkg", "common", "src", "pw-ext-format.ts");
const PACKAGE_FILE = join("pkg", "extension", "package.json");
const roots: string[] = [];

function write(root: string, path: string, text: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

function floorSource(floor: string): string {
	return `export const PW_EXT_MIN_EXTENSION_VERSION = [${floor.split(".").join(", ")}] as const;\n`;
}

function repo(options: { baseFloor: string | null; floor: string; tag?: string }): string {
	const root = mkdtempSync(join(tmpdir(), "floor-check-"));
	roots.push(root);
	git(root, ["init", "-q", "-b", "master"]);
	git(root, ["config", "user.email", "t@example.com"]);
	git(root, ["config", "user.name", "t"]);
	git(root, ["config", "commit.gpgsign", "false"]);
	git(root, ["config", "tag.gpgsign", "false"]);
	write(root, PACKAGE_FILE, JSON.stringify({ version: "7.1.0" }));
	if (options.baseFloor !== null) write(root, FLOOR_FILE, floorSource(options.baseFloor));
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "chore(x): base"]);
	git(root, ["update-ref", "refs/remotes/origin/master", "HEAD"]);
	if (options.tag) git(root, ["tag", options.tag]);
	write(root, FLOOR_FILE, floorSource(options.floor));
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "feat(cli)!: raise the floor"]);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("main wires git, the package version and the floor file", () => {
	const env = { BASE_REF: "master", PR_TITLE: "feat(cli)!: x" };

	test("requires BASE_REF", () => {
		const root = repo({ baseFloor: "7.1.0", floor: "8.0.0", tag: "v7.1.0" });
		expect(() => main({}, root)).toThrow("BASE_REF is required");
	});

	test("passes a raised floor against the previous tag", () => {
		const root = repo({ baseFloor: "7.1.0", floor: "8.0.0", tag: "v7.1.0" });
		expect(main(env, root)).toEqual({
			ok: true,
			message: "the floor 8.0.0 is consistent with release 8.0.0",
		});
	});

	test("with no previous tag reads no commits and relies on the title", () => {
		const root = repo({ baseFloor: "7.1.0", floor: "8.0.0" });
		expect(main(env, root).ok).toBe(true);
		const lower = main({ BASE_REF: "master", PR_TITLE: "docs(x): y" }, root);
		expect(lower.ok).toBe(false);
	});

	test("treats a missing base floor file as a changed floor", () => {
		const root = repo({ baseFloor: null, floor: "7.1.0", tag: "v7.1.0" });
		const result = main(env, root);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("is not above the released extension 7.1.0");
	});

	test("throws when the floor file has no constant", () => {
		const root = repo({ baseFloor: "7.1.0", floor: "8.0.0", tag: "v7.1.0" });
		write(root, FLOOR_FILE, "export const OTHER = 1;\n");
		expect(() => main(env, root)).toThrow(/no PW_EXT_MIN_EXTENSION_VERSION/);
	});
});

describe("extension-floor-check wiring", () => {
	test("runs on pull requests with full history and env-only untrusted input", () => {
		const workflow = readRepoFile(".github", "workflows", "blt-gate.yml");
		expect(workflow).toContain("bun scripts/extension-floor-check.ts");
		expect(workflow).toContain("fetch-depth: 0");
		expect(workflow).toContain("PR_TITLE: ${{ github.event.pull_request.title }}");
		expect(workflow).toContain("PR_BODY: ${{ github.event.pull_request.body }}");
		expect(workflow).toContain("BASE_REF: ${{ github.base_ref }}");
		expect(workflow).not.toMatch(/run:.*\$\{\{ github\.event\.pull_request\.(title|body)/);
	});
});

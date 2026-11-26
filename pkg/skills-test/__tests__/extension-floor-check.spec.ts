import { describe, expect, test } from "bun:test";
import {
	checkFloor,
	compareVersions,
	parseFloor,
	type FloorInput,
} from "../../../scripts/extension-floor-check";
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

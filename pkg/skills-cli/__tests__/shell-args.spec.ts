import { describe, expect, test } from "bun:test";
import { buildArgs } from "../src/utils/shell-args";

function tag(strings: TemplateStringsArray, ...values: unknown[]): string[] {
	return buildArgs(strings, values);
}

describe("buildArgs", () => {
	test("plain template with no interpolation splits on whitespace", () => {
		expect(tag`status --porcelain`).toEqual(["status", "--porcelain"]);
	});

	test("single value preceded by whitespace becomes its own arg", () => {
		const branch = "main";
		expect(tag`checkout ${branch}`).toEqual(["checkout", "main"]);
	});

	test("value with internal spaces preceded by whitespace stays one arg", () => {
		const msg = "hello world";
		expect(tag`commit -m ${msg}`).toEqual(["commit", "-m", "hello world"]);
	});

	test("concatenated token branch-${name} produces one arg", () => {
		const name = "foo";
		expect(tag`checkout branch-${name}`).toEqual(["checkout", "branch-foo"]);
	});

	test("concatenated token with internal whitespace in value stays one arg (value never split)", () => {
		const value = " x";
		expect(tag`prefix-${value}`).toEqual(["prefix- x"]);
	});

	test("null value is skipped", () => {
		const v: string | null = null;
		expect(tag`status ${v} --porcelain`).toEqual(["status", "--porcelain"]);
	});

	test("undefined value is skipped", () => {
		const v: string | undefined = undefined;
		expect(tag`status ${v} --porcelain`).toEqual(["status", "--porcelain"]);
	});

	test('empty string value is skipped (no bare "" arg pushed)', () => {
		const v = "";
		expect(tag`run view --job ${v} --log-failed`).toEqual([
			"run",
			"view",
			"--job",
			"--log-failed",
		]);
	});

	test("array value is spread as multiple args", () => {
		const files = ["a.ts", "b.ts", "c.ts"];
		expect(tag`add ${files}`).toEqual(["add", "a.ts", "b.ts", "c.ts"]);
	});

	test("api path with slash interpolation stays one arg", () => {
		const owner = "octocat";
		const repo = "Hello-World";
		expect(tag`api repos/${owner}/${repo}/pulls`).toEqual([
			"api",
			"repos/octocat/Hello-World/pulls",
		]);
	});

	test("interpolation followed by literal continues the same arg", () => {
		const id = "42";
		expect(tag`api comments/${id}/replies`).toEqual([
			"api",
			"comments/42/replies",
		]);
	});

	test("multiple flags and interpolations", () => {
		const owner = "a";
		const repo = "b";
		const pr = 5;
		expect(
			tag`api graphql -F owner=${owner} -F repo=${repo} -F pr=${pr}`,
		).toEqual([
			"api",
			"graphql",
			"-F",
			"owner=a",
			"-F",
			"repo=b",
			"-F",
			"pr=5",
		]);
	});
});

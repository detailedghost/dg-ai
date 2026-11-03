import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NEW_SHA, run, sourceOf } from "./bump-support";
import { importedPlugins, MARKETPLACE_PATH, readMarketplace } from "./marketplace-support";
import { removeTempDirs } from "./test-support";

afterEach(removeTempDirs);

describe("bump-plugin-pin.ts", () => {
	const before = sourceOf(readMarketplace(), "mattpocock-skills");

	test("rewrites the sha from ls-remote output and prints old -> new", () => {
		const result = run(
			["mattpocock-skills"],
			`printf '${NEW_SHA}\\trefs/heads/main\\n'`,
		);
		expect(result.code).toBe(0);
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(NEW_SHA);
		expect(result.stdout).toContain(before.sha);
		expect(result.stdout).toContain(NEW_SHA);
		expect(result.stdout.indexOf(before.sha)).toBeLessThan(result.stdout.indexOf(NEW_SHA));
	});

	test("asks ls-remote for the repo url and the recorded ref", () => {
		const result = run(["mattpocock-skills"], `printf '${NEW_SHA}\\trefs/heads/main\\n'`);
		const call = result.gitArgs.find((line) => line.includes("ls-remote")) ?? "";
		expect(call).toContain(`https://github.com/${before.repo}.git`);
		expect(call).toContain(before.ref);
	});

	test("--ref overrides the ref passed to ls-remote", () => {
		const result = run(
			["mattpocock-skills", "--ref", "next"],
			`printf '${NEW_SHA}\\trefs/heads/next\\n'`,
		);
		expect(result.gitArgs.join("\n")).toMatch(/ls-remote .* next/);
		expect(result.gitArgs.join("\n")).toContain("next^{}");
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(NEW_SHA);
		expect(sourceOf(result.marketplace, "mattpocock-skills").ref).toBe("next");
	});

	test("refuses a ref with characters outside a branch or tag name and keeps the file", () => {
		const result = run(["mattpocock-skills", "--ref", 'a"b$&'], `printf '${NEW_SHA}\\trefs/heads/main\\n'`);
		expect(result.code).toBe(1);
		expect(result.raw).toBe(readFileSync(MARKETPLACE_PATH, "utf8"));
		expect(result.gitArgs).toEqual([]);
	});

	test("exits 3 when git cannot run", () => {
		const result = run(["mattpocock-skills"], "", { withGit: false });
		expect(result.code).toBe(3);
		expect(result.raw).toBe(readFileSync(MARKETPLACE_PATH, "utf8"));
	});

	test("leaves every other entry untouched", () => {
		const result = run(["mattpocock-skills"], `printf '${NEW_SHA}\\trefs/heads/main\\n'`);
		const original = readMarketplace();
		for (const plugin of importedPlugins(original).filter((p) => p.name !== "mattpocock-skills"))
			expect(result.marketplace.plugins.find((p) => p.name === plugin.name)).toEqual(plugin);
		expect(result.marketplace.plugins.find((p) => p.name === "dg")).toEqual(
			original.plugins.find((p) => p.name === "dg"),
		);
	});

	test("exits 3 and keeps the sha when the repo is unreachable", () => {
		const result = run(["mattpocock-skills"], `echo 'fatal: unable to access' >&2\nexit 128`);
		expect(result.code).toBe(3);
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(before.sha);
	});

	test("fails for a name that has no github entry", () => {
		const result = run(["no-such-plugin"], `printf '${NEW_SHA}\\trefs/heads/main\\n'`);
		expect(result.code).toBe(1);
	});

	test("reports unchanged and keeps the file when upstream has not moved", () => {
		const result = run(["mattpocock-skills"], `printf '${before.sha}\\trefs/heads/main\\n'`);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("unchanged");
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(before.sha);
	});

	test("exits 1 when ls-remote returns no matching ref", () => {
		const result = run(["mattpocock-skills"], "true");
		expect(result.code).toBe(1);
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(before.sha);
	});

	test("exits 1 with a usage message when no name is given", () => {
		const result = run([], "true");
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/usage/i);
		expect(result.gitArgs).toEqual([]);
	});

	test("--ref writes the new ref when the sha is unchanged", () => {
		const result = run(["mattpocock-skills", "--ref", "next"], `printf '${before.sha}\\trefs/heads/next\\n'`);
		expect(result.code).toBe(0);
		expect(sourceOf(result.marketplace, "mattpocock-skills").ref).toBe("next");
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(before.sha);
	});

	test("rewrites only the named entry", () => {
		const unslop = sourceOf(readMarketplace(), "unslop");
		const result = run(["unslop"], `printf '${NEW_SHA}\\trefs/heads/${unslop.ref}\\n'`);
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(before.sha);
		expect(sourceOf(result.marketplace, "unslop").sha).toBe(NEW_SHA);
	});

	test("rewrite keeps tab indentation and a trailing newline", () => {
		const result = run(["mattpocock-skills"], `printf '${NEW_SHA}\\trefs/heads/main\\n'`);
		expect(result.raw.endsWith("\n")).toBe(true);
		expect(result.raw).not.toMatch(/^ +"/m);
	});

	test("exits 1 and keeps the sha when only a nested branch matches the ref", () => {
		const result = run(["mattpocock-skills"], `printf '${NEW_SHA}\\trefs/heads/changeset-release/main\\n'`);
		expect(result.code).toBe(1);
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(before.sha);
	});

	test("prefers the exact branch row over a nested branch row", () => {
		const other = "f".repeat(40);
		const result = run(
			["mattpocock-skills"],
			`printf '${other}\\trefs/heads/changeset-release/main\\n${NEW_SHA}\\trefs/heads/main\\n'`,
		);
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(NEW_SHA);
	});

	test("writes the peeled commit sha for an annotated tag", () => {
		const tagObject = "e".repeat(40);
		const result = run(
			["mattpocock-skills", "--ref", "v1"],
			`printf '${tagObject}\\trefs/tags/v1\\n'\ncase "$*" in *'v1^{}'*) printf '${NEW_SHA}\\trefs/tags/v1^{}\\n';; esac`,
		);
		expect(result.gitArgs.join("\n")).toContain("v1^{}");
		expect(sourceOf(result.marketplace, "mattpocock-skills").sha).toBe(NEW_SHA);
		expect(sourceOf(result.marketplace, "mattpocock-skills").ref).toBe("v1");
	});

	test("changes only the sha line so the inline layout survives", () => {
		const result = run(["mattpocock-skills"], `printf '${NEW_SHA}\\trefs/heads/main\\n'`);
		expect(result.raw).toBe(readFileSync(MARKETPLACE_PATH, "utf8").replace(before.sha, NEW_SHA));
	});

	test("exits 2 with a clear message when marketplace.json is missing", () => {
		const result = run(["mattpocock-skills"], "true", { withMarketplace: false });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not found");
	});
});

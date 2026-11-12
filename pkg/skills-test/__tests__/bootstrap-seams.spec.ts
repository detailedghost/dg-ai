import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

const script = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
const code = script
	.split("\n")
	.filter((line) => !line.trimStart().startsWith("#"))
	.join("\n");

describe("bootstrap.sh seams", () => {
	test("every download goes through DG_CURL, never a bare curl", () => {
		expect(code).toContain('CURL="${DG_CURL:-curl}"');
		expect(code).not.toMatch(/(^|[\s$(|;])curl\s+-/m);
	});

	test("the platform comes from DG_UNAME, never a bare uname", () => {
		expect(code).toContain('UNAME="${DG_UNAME:-uname}"');
		expect(code).not.toMatch(/\$\(uname\s/);
	});
});

describe("bootstrap.sh current links", () => {
	test("replaces runtime/current and lib/current by create-then-rename, not ln -sfn", () => {
		expect(code).not.toContain("ln -sfn");
		expect(code).toMatch(/link_current "\$\{ROOT\}\/runtime\/current"/);
		expect(code).toMatch(/link_current "\$\{ROOT\}\/lib\/current"/);
	});
});
